# backend/agent_graph.py
from __future__ import annotations

import uuid
from typing import Annotated, Literal
from typing_extensions import TypedDict

from dotenv import load_dotenv

from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_tavily import TavilySearch
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, BaseMessage

from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
import os
import sqlite3
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command, interrupt

load_dotenv("../.env")

MODEL_NAME = "gpt-5-mini"

DEBUG_MODE = True


def print_debug(title: str, content: str) -> None:
    if DEBUG_MODE:
        print(f"\n🐛 [DEBUG] {title}:\n{content}\n" + "-" * 40)


# ----------------------------
# Tools
# ----------------------------
tavily_search = TavilySearch(
    max_results=2,
    search_depth="basic",
    include_answer=False,
    include_raw_content=False,
    include_images=False,
)


def format_tavily_results(tavily_response: dict) -> str:
    results = tavily_response.get("results", [])
    if not results:
        return "(No results found)"

    lines = []
    for i, r in enumerate(results, 1):
        title = r.get("title", "")
        # Fall back to raw_content in case content is thin (depending on settings)
        content = r.get("content") or r.get("raw_content") or ""
        url = r.get("url", "")
        lines.append(f"[{i}] {title}\n{content}\nsource: {url}")
    return "\n\n".join(lines)


@tool
def tavily_search_formatted(query: str) -> str:
    """Web search (Tavily). Return formatted top results."""
    tavily_response = tavily_search.invoke({"query": query})
    return format_tavily_results(tavily_response)


tools = [tavily_search_formatted]


# ----------------------------
# State
# ----------------------------
class State(TypedDict):
    research_messages: Annotated[list[BaseMessage], add_messages]
    analysis_messages: Annotated[list[BaseMessage], add_messages]
    loop_count: int


# ----------------------------
# Model
# ----------------------------
model = ChatOpenAI(model=MODEL_NAME)
model_with_tools = model.bind_tools(tools)


# ----------------------------
# Nodes
# ----------------------------
MAX_TOOL_LOOPS = 3

research_prompt_text = """
You are responsible for business research. For the user’s theme, investigate market size, major players, technical challenges, and other relevant factors via web search. Use the best tool when needed.
If you write a prose summary after calling tools, add [n] only when you cite a source URL from the tool output as evidence, and include a reference list at the end. Do not fabricate sources.
"""

research_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", research_prompt_text),
        MessagesPlaceholder(variable_name="research_messages"),
    ]
)
research_chain = research_prompt | model_with_tools


def research_agent(state: State) -> Command[Literal["tools", "summary_agent"]]:
    print_debug("Node", "research_agent")
    response = research_chain.invoke({"research_messages": state["research_messages"]})
    update = {"research_messages": [response]}
    current_count = state.get("loop_count", 0)

    if getattr(response, "tool_calls", None):
        if current_count < MAX_TOOL_LOOPS:
            return Command(update=update, goto="tools")
        return Command(update=update, goto="summary_agent")

    return Command(update=update, goto="summary_agent")


tool_node = ToolNode(tools, messages_key="research_messages")


def research_tool_node(state: State) -> Command[Literal["research_agent"]]:
    result = tool_node.invoke({"research_messages": state["research_messages"]})

    last_message = result["research_messages"][-1]
    tool_text = last_message.content
    tool_text = tool_text if isinstance(tool_text, str) else str(tool_text)
    print_debug("Tool Output", tool_text[:300] + "... (truncated)")

    return Command(
        update={
            "research_messages": result["research_messages"],
            "loop_count": state.get("loop_count", 0) + 1,
        },
        goto="research_agent",
    )


summary_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are an excellent scribe. Summarize the following “research log” and produce a base report that the market analysis team can use. For factual assertions, add [n] wherever possible and include a reference list at the end. Do not fabricate sources.",
        ),
        ("human", "Here is the research log:"),
        MessagesPlaceholder(variable_name="research_messages"),
        ("human", "Based on the above, produce a base report for market analysis."),
    ]
)
summary_chain = summary_prompt | model


def summary_agent(state: State) -> dict:
    print_debug("Node", "summary_agent")
    response = summary_chain.invoke({"research_messages": state["research_messages"]})
    return {"analysis_messages": [response]}


market_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", "You are a professional market analyst. Perform a SWOT analysis based on the report."),
        MessagesPlaceholder(variable_name="analysis_messages"),
    ]
)
market_chain = market_prompt | model


def market_agent(state: State) -> dict:
    print_debug("Node", "market_agent")
    response = market_chain.invoke({"analysis_messages": state["analysis_messages"]})
    return {"analysis_messages": [response]}


technical_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are a CTO. Based on the market analysis, identify technical challenges and assess feasibility.",
        ),
        MessagesPlaceholder(variable_name="analysis_messages"),
    ]
)
technical_chain = technical_prompt | model


def technical_agent(state: State) -> dict:
    print_debug("Node", "technical_agent")
    response = technical_chain.invoke({"analysis_messages": state["analysis_messages"]})
    return {"analysis_messages": [response]}


def human_approval_node(
    state: State,
) -> Command[Literal["market_agent", "report_agent", "__end__"]]:
    payload = {
        "kind": "approval_request",
        "question": "Approve the work so far and generate the investor-facing report?",
        "options": ["y", "retry", "n"],
        "analysis_preview": [
            {
                "type": type(m).__name__,
                "content": (m.content[:500] + "…")
                if isinstance(m.content, str) and len(m.content) > 500
                else m.content,
            }
            for m in state.get("analysis_messages", [])
        ],
    }

    user_decision = interrupt(payload)

    if isinstance(user_decision, str):
        user_decision = user_decision.strip().lower()

    if user_decision == "y":
        return Command(goto="report_agent")
    if user_decision == "retry":
        return Command(goto="market_agent")
    return Command(goto=END)


report_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            """
Integrate everything discussed so far and produce a concrete investor-ready business plan.
Do not add questions or suggestions at the end. End the document with “End of report”.
""",
        ),
        MessagesPlaceholder(variable_name="analysis_messages"),
    ]
)
report_chain = report_prompt | model


def report_agent(state: State) -> dict:
    print_debug("Node", "report_agent")
    response = report_chain.invoke({"analysis_messages": state["analysis_messages"]})
    return {"analysis_messages": [response]}


# ----------------------------
# Build Graph
# ----------------------------
builder = StateGraph(State)
builder.add_node("research_agent", research_agent)
builder.add_node("tools", research_tool_node)
builder.add_node("summary_agent", summary_agent)
builder.add_node("market_agent", market_agent)
builder.add_node("technical_agent", technical_agent)
builder.add_node("human_approval", human_approval_node)
builder.add_node("report_agent", report_agent)

builder.add_edge(START, "research_agent")
builder.add_edge("summary_agent", "market_agent")
builder.add_edge("market_agent", "technical_agent")
builder.add_edge("technical_agent", "human_approval")
builder.add_edge("report_agent", END)

# A checkpointer is required for interrupt/resume (SQLite persistence).
CHECKPOINT_DB_PATH = os.getenv("LANGGRAPH_CHECKPOINT_DB", "checkpoints.sqlite")

# NOTE: check_same_thread=False is OK (assuming you handle locking for thread safety in your implementation) :contentReference[oaicite:3]{index=3}
_conn = sqlite3.connect(CHECKPOINT_DB_PATH, check_same_thread=False)

# Recommended PRAGMA settings for high-contention environments (optional, but often effective in production)
_conn.execute("PRAGMA journal_mode=WAL;")
_conn.execute("PRAGMA synchronous=NORMAL;")
_conn.execute("PRAGMA busy_timeout=5000;")

checkpointer = SqliteSaver(_conn)
checkpointer.setup()  # Initialization such as table creation :contentReference[oaicite:4]{index=4}

graph_app = builder.compile(checkpointer=checkpointer)


# ----------------------------
# Serialization for API
# ----------------------------
def _as_text(m: object) -> str:
    if hasattr(m, "content"):
        c = getattr(m, "content")
        return c if isinstance(c, str) else str(c)
    return str(m)


def serialize_result(result: dict) -> dict:
    """
    Since LangGraph return values may include message objects, convert them into a JSON-serializable form
    for API responses.
    """
    # Extract interrupt (normalize list/tuple/single variants)
    interrupts = result.get("__interrupt__")
    if interrupts:
        first = interrupts[0] if isinstance(interrupts, (list, tuple)) else interrupts
        payload = getattr(first, "value", first)
        return {
            "status": "interrupted",
            "interrupt": payload,
        }

    analysis = result.get("analysis_messages", [])
    analysis_serialized = [
        {"type": type(m).__name__, "content": _as_text(m)} for m in analysis
    ]

    report_text = analysis_serialized[-1]["content"] if analysis_serialized else ""

    return {
        "status": "completed",
        "report": report_text,
        "analysis_messages": analysis_serialized,
    }


def run_graph_start(theme: str, thread_id: str) -> dict:
    initial_state: dict = {
        "research_messages": [HumanMessage(content=f"Theme: {theme}")],
        "loop_count": 0,
        "analysis_messages": [],
    }
    config = {"configurable": {"thread_id": thread_id}}
    raw = graph_app.invoke(initial_state, config=config)
    return serialize_result(raw)


def run_graph_resume(decision: str, thread_id: str) -> dict:
    config = {"configurable": {"thread_id": thread_id}}
    raw = graph_app.invoke(Command(resume=decision), config=config)
    return serialize_result(raw)


def new_thread_id() -> str:
    return str(uuid.uuid4())


def close_checkpointer() -> None:
    global _conn
    try:
        _conn.close()
    except Exception:
        pass