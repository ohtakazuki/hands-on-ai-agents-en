# Hands-On AI Agents with Python, LangChain, and LangGraph

This is the official companion source code repository for the book  
**_Hands-On AI Agents with Python, LangChain, and LangGraph_**.

It includes the full set of step-by-step examples from the book—both **Jupyter Notebooks** and **web app implementations**—so you can follow along and reproduce each result on your own machine.

> ✅ The book is written in a meticulous, beginner-friendly style: **step-by-step explanations with screenshots**, focusing on “it actually works” implementations you can run and extend.

---

## 📘 About the Book

Generative AI is evolving from “chatbots that answer questions” to **agentic systems** that can plan, use tools, retrieve knowledge, and take actions toward a goal.

This book is a practical guide to building **production-minded AI agents** using **Python**, **LangChain**, and **LangGraph**, based on best practices for the **LangChain v1.0 / LangGraph v1.0** era—from fundamentals all the way to deployment as a streaming web app.

### What you’ll learn

- Build chatbots using the OpenAI API
- Create LangChain workflows (prompt templates, tool integration, structured output, etc.)
- Implement complex agent graphs and state management with LangGraph
- Add **Human-in-the-Loop (HITL)** approvals for real-world operations
- Deploy agents as web apps using **LangGraph Server** (Agent Server) and **LangServe**

---

## 📂 Repository Structure

Below is an overview of the key files and folders.

### Jupyter Notebooks (Foundations / Learning)

- `llm_basic.ipynb`: Chat Completions API basics and parameters
- `langchain_basic.ipynb`: Core LangChain components
- `langchain_chain.ipynb`: Building chains with LCEL
- `langchain_webbot.ipynb`: Web-search-enabled chatbot
- `langchain_middle.ipynb`: Middleware extensions (guardrails, etc.)
- `graph_basic.ipynb`: LangGraph fundamentals (nodes, edges, state)
- `graph_bot.ipynb`: A stateful chatbot with LangGraph
- `graph_webbot.ipynb`: An agent with a tool-calling loop
- `graph_ragbot.ipynb`: A RAG (retrieval-augmented generation) agent
- `aiagent.ipynb`: The main multi-feature AI agent from the book

### Web Apps (Applied / Deployment)

- `frontend/`: Web UI with LangGraph Server as the backend
- `frontend_ls/`: Web UI with LangServe as the backend
- `graphs/`: Graph definitions deployed to LangGraph Server
- `backend/`: Server implementation for LangServe
- `langgraph.json`: LangGraph Server configuration

---

## 🚀 Corporate Training & Workshops

**Forest LLC** provides hands-on corporate training programs that help teams move from “learning generative AI” to “using it in real work.”

Rather than focusing only on theory, our programs emphasize **exercise-driven, reproducible workflows**—the same style used throughout this repository—so engineers can quickly gain skills they can apply inside their own organizations.

### Example training programs

- **Generative AI Fundamentals Workshop**: from prompt engineering basics to practical use cases
- **AI Agent Development Workshop**: advanced development with LangChain / LangGraph (topics covered in this book)
- **Developer Tooling Enablement**: next-gen development workflows with GitHub Copilot, Cursor, and more
- **No-Code AI App Development**: building AI apps with tools like Dify (for non-engineers as well)

We can customize training to match your team’s domain and skill level. Free online consultations are available—feel free to reach out.

🌐 **Forest LLC Website**: https://forest1.net/
