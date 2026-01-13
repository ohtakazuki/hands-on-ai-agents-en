# backend/server.py
from __future__ import annotations

from typing import Optional, Literal, Union
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from langchain_core.runnables import RunnableLambda
from langserve import add_routes

from agent_graph import (
    new_thread_id,
    run_graph_start,
    run_graph_resume,
)

from contextlib import asynccontextmanager
from agent_graph import close_checkpointer

# ----------------------------
# FastAPI app
# ----------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    close_checkpointer()

app = FastAPI(title="LangServe + LangGraph HITL Agent", lifespan=lifespan)

# Allow CORS during development so we can call it from Live Server (e.g., http://127.0.0.1:5500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict this in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Input/Output Schema
# ----------------------------
class AgentRequest(BaseModel):
    action: Literal["start", "resume"] = Field(..., description="start or resume")
    thread_id: Optional[str] = Field(None, description="ID to resume within the same thread")
    theme: Optional[str] = Field(None, description="Theme for start")
    decision: Optional[str] = Field(None, description="Input for resume (y/n/retry)")


def agent_entry(req: Union[AgentRequest, dict]) -> dict:
    # LangServe’s /invoke accepts { input: ... }, and sometimes the runnable receives the inner dict.
    # If it’s a dict, wrap it into AgentRequest so we can use attribute access.
    if isinstance(req, dict):
        req = AgentRequest(**req)

    # If thread_id is missing, issue a new one on start.
    tid = req.thread_id or new_thread_id()

    print(f"[agent_entry] action={req.action} thread_id={tid}")

    if req.action == "start":
        theme = req.theme or "Space debris removal business"
        print(f"[agent_entry] start theme={theme}")  
        data = run_graph_start(theme=theme, thread_id=tid)
        print(f"[agent_entry] start done status={data.get('status')}")  
        return {"thread_id": tid, **data}

    # resume
    decision = (req.decision or "").strip().lower()
    print(f"[agent_entry] resume decision={decision}")  
    data = run_graph_resume(decision=decision, thread_id=tid)
    print(f"[agent_entry] resume done status={data.get('status')}")  
    return {"thread_id": tid, **data}


runnable = (
    RunnableLambda(agent_entry)
    # LangServe may fail schema generation via input-type inference, so specify it explicitly.
    .with_types(input_type=AgentRequest, output_type=dict)
)

# LangServe routes:
# Automatically generates endpoints such as POST /agent/invoke
add_routes(app, runnable, path="/agent")

# run:
# uvicorn server:app --reload --port 8000