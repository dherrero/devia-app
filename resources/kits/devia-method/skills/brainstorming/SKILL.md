---
name: brainstorming
description: "Before building or changing anything non-trivial: find out what the user really wants, agree a design, record it as a kanban spec."
---

# Brainstorming

You are very good at building. You build what you believe the user wants, and that belief is usually thinner than it feels. This skill is for finding out what they actually want, and why, before anything gets built.

People often haven't finished working out what they want. Good questions help them think it through. When you understand the why, you make the hundred decisions they never mention the way they would have made them.

## First: What Do You Actually Know?

Before you reply, ask yourself: what do I know about what they want, and why?

- **Everything that matters is in the request** ("make the icon cornflower blue"). This is a quick, clear task. Do it, and say what you did.
- **Something non-trivial is missing.** Start the conversation.

Before you start implementing, you must, in order:

1. Lay out the approaches in a message of their own, and have the user pick one (see Lay out the approaches).
2. Write the design, short or full (see Size the Work), in the conversation.
3. Get their approval of it, then record it as ONE kanban spec.
4. Load `writing-plans`.

Two things aren't implementing: a spike they said yes to (see Spike to feel things out), and doing what they asked once they've opted out of the questions.

## Look Before You Ask

Never ask what the project or Devia already answers. Before your first message:

- `mem_search` for the topic: earlier decisions, constraints and lessons are already recorded.
- `kanban_list_specs` (then `kanban_get_task` where useful): a related spec may exist, in progress or done. Extend it rather than starting a parallel one.
- In an existing project, or when they gave you context (a spec, a handoff, files they pointed at, earlier conversation), read what they referred to and the code it connects to, until you can explain how the relevant parts work today and what this change would touch.

## Your First Message

Move the work forward, with one of these:

- **They've already said what they want** (a spec, a detailed request): aim for about 200 words for the whole message. Echo their request back in your own words, so they can see whether you've got its shape: what they want, who it's for, and why, as far as they've said. Add what you found that bears on it: how the relevant parts work today and what the change would touch. If you found something they may not have considered that would change what they're asking for or how it has to be built, like a constraint, a conflict, or a cheaper path, say so plainly. How to build it comes later (see Lay out the approaches). End with one line inviting corrections, then one question about what they want: the thing their request leaves open whose answer would most change what gets built. Specs are often incomplete, so confirm before you build on one.
- **They haven't:** one open question, in their own terms, about the biggest thing their request leaves unsettled. Say why you're asking: what the answer would change about what you build. For "a website for my bakery": "If it's mostly for people deciding whether to stop by, I'd lead with hours and what's in the case today; taking orders is a different site. What do you want someone to do when they land on it?"

How the message ends depends on whether their message asked for brainstorming:

- **They asked for it** (by name, or by asking for a design discussion): end with your question. They want this conversation.
- **They didn't:** they may not want a conversation at all. After your question, add a light, one-line offer to just get going instead, like "Or if you'd rather I just dive in, say so." If they take you up on it, this skill is done: state any significant how-it-gets-made choice (platform, language, medium) in one plain line, then do what they asked through the normal workflow.

That's the whole message.

## The Conversation

Each message ends with one question: a single sentence with no list of example answers hanging off it. Use plain language, pitched just a little above where the user is. Match their vocabulary; never use process jargon. You never need to quote this skill to them.

Be clear and concise. Lead with what matters. When you report what you found, give them the most important findings and offer the rest.

**Get them describing.** Open questions come first, in plain conversation. Their own words carry intent that your options can't. Use a `devia_ask_user` card only for a real choice between a few options, and only when they're stuck. When they say "just guess" or "what do you think?", propose something concrete.

**How it gets made.** Every project rests on choices about medium, tools, materials and resources: the platform, language and libraries for an app. Find out early which of those choices they want to make, which they're handing to you, and what they already have to work with. Someone with strong views will want to talk it through. Someone counting on you needs sensible defaults, said in plain words. When there's existing work, build on what it already uses. Any choice you make goes in the design as your call, never as something they agreed to.

**Ground to cover.** This is territory, not a script. Never read these out as questions:

- what kind of thing this is, and what makes it special
- why now, and what success looks like to them
- goals, non-goals, and anti-goals (what would make this a failure even if it technically works)
- prior art: what they've seen elsewhere, loved or hated
- current state: what exists now, what they've tried
- the details they care about

**Make every question specific** to their project and what they've told you. Ask Socratically, the way a sharp colleague would: build each question on their last answer or on something you found, so it helps them think through a consequence or a case they may have missed ("Voting closes before the meeting, and two members joined this month. Does someone who joins mid-round get a vote?"). When the reason isn't already plain, say what you're hoping to learn or what the answer would change. A proposal they can correct, plus your reason for it, often beats a question.

**Offer recon.** Once you have a bit of grounding and looking further would help, offer to go look: deeper into their codebase, their own files and data, or the web. Say what you'd look for. They decide whether you go.

**Lay out the approaches.** Once you understand what they want, and before you write anything up, put the ways of building it in a message of its own. Come up with several real alternatives and drop the weak ones, including any that work against why they want it and any the existing work rules out. Present the two or three that remain, grounding each in what the project actually does and saying what it trades off. Recommend one and say why, then ask which way they want to go. When there's genuinely one sensible way, say so and explain why the others don't fit. This is for how it gets made; for what they want, get them describing first.

**Show, don't tell.** When seeing would help more than reading, put it in the message: a small table, a layout sketched in text, a flow as numbered steps, two options side by side. Keep it short.

**Spike to feel things out.** Agentic work is waterfall, but very, very fast. A quick throwaway build is often the cheapest way to learn what they want or whether something works. Offer one when it would help, and offer it in a split pane: Devia gives the pane its own worktree, so the spike never touches their checkout. When they just want to spike, get out of the way. Spikes get no tests or minimal ones, aren't bulletproof, and skip the plan, implementation and review process. Bring what the spike taught you back into the conversation.

## Play It Back

Play back as you go. As soon as you understand one part well enough to describe it (what it's for and who it serves, say, or how one piece behaves), describe that part back in about 200-300 words, then return to questions about the next part. Playback and questions alternate through the whole conversation; the last chunk covers whatever is left.

Only what they said goes in as theirs. Anything you filled in goes in as your proposal, with your reason. End each chunk by asking what's wrong or missing.

## Size the Work

Once you understand what they want and they've picked an approach, say how big the work is in plain words. They can override it.

| Size | The spec |
|------|----------|
| A small change | a short one: what you already covered together, written down |
| A project | the full written design (below) |

Short or full, the spec has an **Approaches** part: the two or three ways you considered building it, what each trades off, which one they picked, and why. They pick in the conversation, before you write the spec.

If it grows mid-task, stop, say so, and step up a size. If this is really several independent projects, say so, agree on an order, and brainstorm them one at a time (one spec each).

## The Written Design

Write a plain spec a talented builder could plan from without going back to the user. Cover:

- intent and the why
- goals, non-goals, anti-goals
- constraints
- approaches (above)
- the parts of the how they decided, as they decided them
- what's left to the builder

**Where it goes:** the draft lives in the conversation while you and the user shape it. Once they approve it, record it with ONE `kanban_create_spec` whose description is the approved design. The board cannot edit a spec after it is created, so creating one early leaves a stale duplicate behind. It is not a file in the repository and nothing is committed: the board is where the user, the plan and any other agent will find it. If the user explicitly asks for a markdown file in their repository, write it too (apply mode only). Their preferences override this default.

For a small change, the short spec covers the same points in a line or two each and goes straight to the user, without the builder check.

**Builder check** (for a project): dispatch a fresh subagent with `builder-check-prompt.md` in this directory, giving it the spec text (it cannot read the board for you). When you tell the user you're writing it up, say a reviewer will read it first and you may come back once with a few questions. Don't ask for approval until the check is back. Sort what the builder asks into three piles:

- **Answered already** by the conversation or the project: put the answer in the spec.
- **Minor:** a sensible builder could settle it without changing what gets built. Settle it yourself and mark it in the spec as your call.
- **Theirs:** only the user can answer it, and the answer changes what gets built.

Bring the "theirs" pile in one message, most important first. Update the draft with their answers, then hand it over with a short list of the calls you made so they can check those while reading. That's the only round of questions the check produces. Without a subagent tool, read the spec as that builder yourself.

**Approval.** Show them the draft (or its summary) and ask with `devia_ask_user`: approve, or ask for changes. If cards aren't offered, ask in plain text and end your turn. When they approve, call `kanban_create_spec` once with the approved text, save the decisions that will outlive this conversation with `mem_save` (type `decision`: what was decided and why), then load `writing-plans`.

<HARD-GATE>
Nothing gets built until the user approves the design: the short one for a small change, the full one for a project. Building includes writing product code, scaffolding, installing dependencies, creating projects, and loading an implementation skill. Reading and exploring are fine.

Two exceptions. If they opted out of the questions, the skill is done and the gate goes with it. A spike they said yes to may be built; it stays labeled throwaway, and keeping what it produced is a new request that comes back through this gate.

After the design is approved and recorded, the next step is the plan: load `writing-plans` and no other skill.
</HARD-GATE>

## Red Flags

| Thought | Reality |
|---------|---------|
| "I'll offer a menu of what they might want" | Options steer. Ask them to describe it first. |
| "I'll fill in sensible defaults" | Good. Say them out loud. A default they never heard is one they couldn't reject. |
| "I've answered their questions, so I'll write the spec" | Lay out the approaches first, in a message of their own. |
| "I should explain the process first" | Ask your question. The process shows itself. |
| "They said 'sounds good' to the idea" | Approval covers what you showed them. A design you haven't written isn't approved. |
| "The spike works, I'll keep building on it" | Keeping it is a new request. Back through the gate. |
| "The spec belongs in docs/" | It belongs on the board. Write a file only if they ask for one. |
