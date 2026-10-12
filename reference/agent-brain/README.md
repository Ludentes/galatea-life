# The agent-brain: a coding agent as a brain on the steward

A coding agent (Claude Code, or another tool that reads `AGENTS.md` and an MCP configuration) acting
as a Galatea brain ([`standard/brain.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/brain.md)) at the owner's chat window. This directory holds only its
**connection** so far: how it reaches the steward, what it presents and trusts, and the few rules it
must keep from the first call. Its skills, its prompts and its trial on models come in a later plan
(the roadmap's agent-brain).

| File | What it is |
|---|---|
| `.mcp.json` | The MCP server `galatea`: the steward's URL (`GALATEA_STEWARD_URL`, `https://127.0.0.1:18444/mcp` unless set), and `Authorization: Bearer ${GALATEA_BRAIN_CREDENTIAL}` |
| `bin/galatea-agent-brain` | The launcher: reads the brain's two files, sets the credential, the CA and the URL for the agent's process alone, and starts the agent here |
| `AGENTS.md` | The rules every model gets: its endpoint, the steward as its only way into the home, and never answering a confirmation for the person |
| `skills/galatea-steward/SKILL.md` | The calls: `describe`, `state`, `plan`, waiting on an ask, `apply`, `outcome`; `AGENTS.md` sends the agent to it |

There is no `CLAUDE.md` and nothing under `.claude/`: the workshop keeps those for its own agents
and never exports them, so the launcher gives Claude Code `AGENTS.md` with
`--append-system-prompt`, and the skill is a file `AGENTS.md` names, which any agent tool can read.

## Setting it up on the box

The installation's README covers the stack. For the brain (the install-core design, *How the owner
and a brain reach the steward*):

1. An account of its own, with no sudo and not in the `docker` group:
   `sudo useradd -m galatea-brain`.
2. Its credential and the CA, from the installation's directory, as the owner:
   `bin/galatea-secret brain_agent --for galatea-brain`. The account gets
   `~/.config/galatea/brain_agent` (0600) and `~/.config/galatea/ca.pem`, and nothing else of the
   installation.
3. With the owner's tool, at `owner-app`: the credential
   (`galatea credential brain_agent --kind brain --confirm-on owner-app`) and its chat endpoint
   (`owner-chat`: `type: app`, `person: owner`, `served_by: brain_agent`, `confirm_on: owner-app`).
4. As `galatea-brain`, from a checkout of this repository it can read:
   `reference/agent-brain/bin/galatea-agent-brain` (Claude Code, `claude` on its `PATH`), or
   `reference/agent-brain/bin/galatea-agent-brain <agent command>` for another tool. Claude Code asks
   once whether to use the project's MCP server `galatea`; say yes.

The launcher refuses root and an account in the `docker` group. It puts the credential in the agent's
environment, where `.mcp.json` expands it; the agent's own shell can read it there, as it could read
the file: both are the brain's own. `NODE_EXTRA_CA_CERTS` adds the installation's CA to the agent's
process, which is where GA-BRAIN-16 asks the brain to trust it; it changes no other account's trust.

## What it is held to

`reference/install/test/first-light.test.ts` runs this launcher and this `.mcp.json`, as an account
of its own holding only its two files, against the installed stack: the brain switches a simulated
lamp, and its own `answer` to an ask put on the owner's app is refused `not_permitted`.

Not checked yet, and left to the agent-brain's own plan: whether a given agent tool expands
`${VAR:-default}` in `url` and `${VAR}` in `headers` as the test's stand-in does (Claude Code
documents both), whether it offers a header helper that would keep the credential out of its
environment, and how any model keeps `AGENTS.md`'s rules.
