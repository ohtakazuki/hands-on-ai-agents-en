# graphs/agent_graph.py
from __future__ import annotations

import os
import datetime as _dt
from typing import Annotated, Literal
from typing_extensions import TypedDict

from langchain_openai import ChatOpenAI
from langchain_core.messages import BaseMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.tools import tool

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import Command, interrupt

# ----------------------------
# Settings
# ----------------------------
MODEL_NAME = os.getenv("MODEL_NAME", "gpt-5-mini")
DEBUG_MODE = os.getenv("DEBUG_MODE", "true").lower() == "true"
MAX_TOOL_LOOPS = int(os.getenv("MAX_TOOL_LOOPS", "3"))
TODAY_STR = _dt.date.today().isoformat()


def print_debug(title: str, content: str) -> None:
    if not DEBUG_MODE:
        return
    print(f"\n🐛 [DEBUG] {title}:\n{content}\n" + "-" * 40)


# ----------------------------
# Tools
# ----------------------------
def _format_tavily_results(tavily_response: object) -> str:
    if not isinstance(tavily_response, dict):
        return f"(Unexpected search result format)\nraw: {tavily_response!r}"

    results = tavily_response.get("results", []) or []
    if not results:
        return "(No results)"

    lines: list[str] = []
    for i, r in enumerate(results, 1):
        if not isinstance(r, dict):
            continue
        title = (r.get("title") or "").strip()
        content = (r.get("content") or r.get("raw_content") or "").strip()
        url = (r.get("url") or "").strip()

        # Cap content length to avoid bloating logs/prompts
        if len(content) > 900:
            content = content[:900] + "…"

        lines.append(f"[{i}] {title}\n{content}\nsource: {url}")

    return "\n\n".join(lines) if lines else "(No results)"


def _build_tools():
    # Tavily is optional: the app can still run without a key (search won't work)
    tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not tavily_key:

        @tool
        def tavily_search_formatted(query: str) -> str:
            """Web search (Tavily). If no API key is set, return a helpful message."""
            return (
                "(Web search is unavailable because TAVILY_API_KEY is not set.)\n"
                "Please set TAVILY_API_KEY in your `.env` file."
            )

        return [tavily_search_formatted]

    from langchain_tavily import TavilySearch

    tavily_search = TavilySearch(
        max_results=3,
        search_depth="basic",
        include_answer=False,
        include_raw_content=False,
        include_images=False,
    )

    @tool
    def tavily_search_formatted(query: str) -> str:
        """Web search (Tavily). Returns a formatted list of top results."""
        try:
            tavily_response = tavily_search.invoke({"query": query})
            return _format_tavily_results(tavily_response)
        except Exception as e:
            return f"(Error during Tavily search) {type(e).__name__}: {e}"

    return [tavily_search_formatted]


tools = _build_tools()


# ----------------------------
# State
# ----------------------------
class State(TypedDict, total=False):
    # add_messages reducer: messages passed via `update` are appended to the existing list
    research_messages: Annotated[list[BaseMessage], add_messages]
    analysis_messages: Annotated[list[BaseMessage], add_messages]
    loop_count: int

    # For UI (set at the start of each step)
    current_step: str
    approval_decision: str

    # Final report set only by report_agent
    final_report: str


# ----------------------------
# Model / Chains
# ----------------------------
model = ChatOpenAI(model=MODEL_NAME, temperature=0)
model_with_tools = model.bind_tools(tools)

research_prompt_text = f"""
You are a business research analyst. For the user's topic, research market size, major players, and key technical challenges using web search.
Today is {TODAY_STR}. If newer information is needed, prioritize the most recent sources.
Use the most appropriate tools as needed.

[Citation Rules]
- Only include in-text citations like [n] when you are grounding a claim in a tool output line that includes "source: URL".
- Add a references section at the end with entries in the form: [n] URL
- Do not invent sources or citations.
""".strip()

research_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", research_prompt_text),
        MessagesPlaceholder(variable_name="research_messages"),
    ]
)
research_chain = research_prompt | model_with_tools

summary_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are a skilled note-taker. Summarize the following 'research log' and produce a baseline report the market analysis team can use.\n"
            "For factual claims, add [n] wherever possible, and include a references section at the end ([n] URL). Do not invent sources.\n"
            "Treat only 'source: URL' lines contained in tool outputs as eligible references.",
        ),
        ("human", "Here is the research log:"),
        MessagesPlaceholder(variable_name="research_messages"),
        ("human", "Based on the above, write a baseline report for market analysis."),
    ]
)
summary_chain = summary_prompt | model

market_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", "You are a market analysis professional. Perform a SWOT analysis based on the report."),
        MessagesPlaceholder(variable_name="analysis_messages"),
    ]
)
market_chain = market_prompt | model

technical_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", "You are the CTO. Based on the market analysis, identify technical risks, challenges, and feasibility considerations."),
        MessagesPlaceholder(variable_name="analysis_messages"),
    ]
)
technical_chain = technical_prompt | model

report_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "Synthesize the discussion so far and write a concrete business plan aimed at investors.\n"
            "Do not end with questions or suggestions. End with 'End of report.'",
        ),
        MessagesPlaceholder(variable_name="analysis_messages"),
    ]
)
report_chain = report_prompt | model


# ----------------------------
# Utility: start-marker nodes
# ----------------------------
def _mark_step(step: str, goto: str) -> Command:
    # Lightweight node that updates `current_step` at the start of each step
    return Command(update={"current_step": step}, goto=goto)


# ----------------------------
# Nodes
# ----------------------------
def research_start(state: State) -> Command[Literal["research_agent"]]:
    print_debug("Node", "research_start")
    return _mark_step("research_agent", "research_agent")


def research_agent(state: State) -> Command[Literal["tools_start", "summary_start"]]:
    print_debug("Node", "research_agent")

    response = research_chain.invoke({"research_messages": state.get("research_messages", [])})
    update = {"research_messages": [response]}
    current_count = state.get("loop_count", 0)

    # If the LLM requests tool calls, route to tools
    if getattr(response, "tool_calls", None):
        if current_count < MAX_TOOL_LOOPS:
            return Command(update=update, goto="tools_start")
        return Command(update=update, goto="summary_start")

    return Command(update=update, goto="summary_start")


def tools_start(state: State) -> Command[Literal["tools"]]:
    print_debug("Node", "tools_start")
    return _mark_step("tools", "tools")


tool_node = ToolNode(tools, messages_key="research_messages")


def research_tool_node(state: State) -> Command[Literal["research_start"]]:
    print_debug("Node", "tools")

    result = tool_node.invoke({"research_messages": state.get("research_messages", [])})

    last_message = result["research_messages"][-1]
    tool_text = last_message.content
    tool_text = tool_text if isinstance(tool_text, str) else str(tool_text)
    print_debug("Tool Output", tool_text[:300] + ("... (truncated)" if len(tool_text) > 300 else ""))

    return Command(
        update={
            "research_messages": result["research_messages"],
            "loop_count": state.get("loop_count", 0) + 1,
        },
        goto="research_start",
    )


def summary_start(state: State) -> Command[Literal["summary_agent"]]:
    print_debug("Node", "summary_start")
    return _mark_step("summary_agent", "summary_agent")


def summary_agent(state: State) -> Command[Literal["market_start"]]:
    print_debug("Node", "summary_agent")
    response = summary_chain.invoke({"research_messages": state.get("research_messages", [])})
    return Command(
        update={"analysis_messages": [response], "loop_count": 0},
        goto="market_start",
    )


def market_start(state: State) -> Command[Literal["market_agent"]]:
    print_debug("Node", "market_start")
    return _mark_step("market_agent", "market_agent")


def market_agent(state: State) -> Command[Literal["technical_start"]]:
    print_debug("Node", "market_agent")
    response = market_chain.invoke({"analysis_messages": state.get("analysis_messages", [])})
    return Command(update={"analysis_messages": [response]}, goto="technical_start")


def technical_start(state: State) -> Command[Literal["technical_agent"]]:
    print_debug("Node", "technical_start")
    return _mark_step("technical_agent", "technical_agent")


def technical_agent(state: State) -> Command[Literal["human_approval_start"]]:
    print_debug("Node", "technical_agent")
    response = technical_chain.invoke({"analysis_messages": state.get("analysis_messages", [])})
    return Command(update={"analysis_messages": [response]}, goto="human_approval_start")


def human_approval_start(state: State) -> Command[Literal["human_approval"]]:
    print_debug("Node", "human_approval_start")
    return _mark_step("human_approval", "human_approval")


def _safe_preview_messages(messages: list[BaseMessage], limit: int = 3) -> list[dict]:
    out: list[dict] = []
    tail = messages[-limit:] if limit > 0 else messages
    for m in tail:
        content = m.content
        s = content if isinstance(content, str) else str(content)
        if len(s) > 1200:
            s = s[:1200] + "…"
        out.append({"type": type(m).__name__, "content": s})
    return out


def human_approval_node(
    state: State,
) -> Command[Literal["market_start", "report_start", "__end__"]]:
    """
    HITL (approval) node.
    - `interrupt(payload)` stops execution reliably
    - The resumed value is stored in `approval_decision`
    - If the decision is not 'y', do not proceed to the report step
    """
    print_debug("Node", "human_approval")

    payload = {
        "kind": "approval_request",
        "question": "Approve the work so far and generate the final report?",
        "options": ["y", "retry", "n"],
        "analysis_preview": _safe_preview_messages(state.get("analysis_messages", []), limit=3),
    }

    user_decision = interrupt(payload)
    print_debug("Approval decision (raw)", repr(user_decision))

    if isinstance(user_decision, str):
        decision_str = user_decision.strip().lower()
    else:
        decision_str = str(user_decision).strip().lower()

    if decision_str not in ("y", "retry", "n"):
        decision_str = "n"

    update = {"approval_decision": decision_str}

    if decision_str == "y":
        return Command(update=update, goto="report_start")
    if decision_str == "retry":
        return Command(update=update, goto="market_start")
    return Command(update=update, goto=END)


def report_start(state: State) -> Command[Literal["report_agent"]]:
    print_debug("Node", "report_start")
    return _mark_step("report_agent", "report_agent")


def report_agent(state: State) -> Command[Literal["__end__"]]:
    print_debug("Node", "report_agent")

    if (state.get("approval_decision") or "").strip().lower() != "y":
        return Command(update={"final_report": ""}, goto=END)

    response = report_chain.invoke({"analysis_messages": state.get("analysis_messages", [])})
    text = response.content if isinstance(response.content, str) else str(response.content)

    return Command(update={"analysis_messages": [response], "final_report": text}, goto=END)


# ----------------------------
# Build Graph
# ----------------------------
builder = StateGraph(State)

builder.add_node("research_start", research_start)
builder.add_node("research_agent", research_agent)

builder.add_node("tools_start", tools_start)
builder.add_node("tools", research_tool_node)

builder.add_node("summary_start", summary_start)
builder.add_node("summary_agent", summary_agent)

builder.add_node("market_start", market_start)
builder.add_node("market_agent", market_agent)

builder.add_node("technical_start", technical_start)
builder.add_node("technical_agent", technical_agent)

builder.add_node("human_approval_start", human_approval_start)
builder.add_node("human_approval", human_approval_node)

builder.add_node("report_start", report_start)
builder.add_node("report_agent", report_agent)

builder.add_edge(START, "research_start")

# Transitions are mostly handled via Command.goto (explicit edges kept minimal)
builder.add_edge("report_agent", END)

graph = builder.compile()