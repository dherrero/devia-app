---
name: using-devia
description: "Start of every conversation: how the method's skills work and when to load them."
---

<SUBAGENT-STOP>
If you were dispatched as a subagent for one specific task, ignore this skill.
</SUBAGENT-STOP>

# Using Devia Method

You work inside Devia. These skills are how work gets done here, and they use Devia's own tools: the kanban holds the spec and the plan, memory holds decisions, cards ask and approve, panes isolate.

## The rule

If there is even a small chance a skill applies, load it BEFORE you answer, including before clarifying questions: the skill tells you how to ask and how to explore. When the user asks you to build or change something, loading `brainstorming` is your first tool call, before you read any file.

The one exception is an edit where nothing is open and nothing new is created (rename this variable, use the colour I named): do it and say what you did. Anything new, such as a program, a script, a feature, a page or a component, is never an exception, however small it sounds.

Load a skill with `devia_skill` (`{"op":"load","name":"<skill>"}`; Claude Code: its Skill tool, `devia-method:<skill>`). Say "Using <skill> to <purpose>", then follow it exactly. If it has a checklist, publish one `devia_todo` item per line.

## Where things live

- **Spec and design** → a kanban spec. **Plan** → kanban tasks, ordered with `dependsOn`. **Progress, rulings, deferred findings** → the task's comment thread. **Done** → `kanban_close_task` with the commit. No plan, spec or ledger files.
- **Decisions, root causes, lessons** → memory (`mem_save`); recall with `mem_search` before asking what the project may already have answered.
- **Asking** → plain conversation for open questions, `devia_ask_user` for a choice. **Approving a plan** → `devia_plan_approve`. **Review** → `devia_request_review`. **A risky action** → `devia_confirm`.
- **Isolation** → Devia's panes. Never create, switch or remove a git worktree or a session branch.
- **Plan mode** cannot write files, and nothing here needs a file: the spec, the plan and the approval are all tool calls.

## Order of work

Build or change something → `brainstorming` → `writing-plans` → plan approved → `executing-plans` or `subagent-driven-development` → `requesting-code-review` → `finishing-work`. A bug → `systematic-debugging`. Any implementation → `test-driven-development`. Any claim that something is done → `verification-before-completion`. Process skills come first; they set the approach, then the others carry it out.

## Red flags

| Thought | Reality |
|---------|---------|
| "This is just a question" | Questions are tasks. Check for a skill. |
| "I need more context first" | The skill says how to get it. Load it first. |
| "Let me explore the code first" | Same. Load the skill, then explore the way it says. |
| "I remember this skill" | Skills change. Load the current one. |
| "The skill is overkill" | Small things grow. Use it. |
| "I'll just do this one thing first" | Check before you act. |

What the user says, and AGENTS.md or CLAUDE.md, outrank these skills; the skills outrank your defaults.
