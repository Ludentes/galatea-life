---
title: Running the minimal brain
status: draft
last_verified:
area: brain
audience: owner, dev
author: Galatea maintainers
related:
  - reference/agent-brain/README.md
  - reference/install/README.md
  - standard/brain.md
---

# Running the minimal brain

The minimal brain is Claude Code with a short set of rules (`reference/agent-brain/AGENTS.md`), one
skill, and your home's steward as its only MCP server. You chat with it, and it switches things
through the steward. The steward decides what the brain may do. This runbook starts the brain on a
local model through Ollama, so the model runs on your own machine, and checks that it works. The
brain can still reach the network through its shell; see *What it doesn't do yet*.

It is a test brain, not a product. It shows the chain from a chat to a device and the rules a brain
must keep. Treat it as you would any agent with a shell: run it under an account of its own, as
below.

## What you need

- **An installed Galatea home** (`reference/install`), with its owner tool working: `galatea status`
  shows both servers.
- **At least one adopted device that switches**, such as a plug or a lamp. `galatea devices` lists them;
  note one's id (for example `zigbee:0x…`). The runbook calls it `<lamp>`.
- **A machine for the brain** with an NVIDIA GPU of 20 GB or more (the tested model uses 16.6 GB at
  the context this needs), Linux, and `sudo`. It may be the box itself, or another machine on your
  network.
- About 30 minutes, and 17 GB of disk for the model.

To use Anthropic's cloud models instead of a local one, skip *The model* and the model lines of
*The brain's environment*, and sign Claude Code in as the brain's account. Everything else is the
same.

## Where the brain runs

The steward listens on the box's loopback, `127.0.0.1:18444`. The brain reaches it there:

- **On the box:** nothing to do.
- **On another machine:** forward the port over SSH from that machine, and keep it running while the
  brain runs:

  ```sh
  ssh -N -o ServerAliveInterval=15 -L 127.0.0.1:18444:127.0.0.1:18444 <you>@<box>
  ```

  The steward's certificate is for `127.0.0.1`, so the brain checks it through the tunnel as it would
  on the box.

## The brain's account and credential

The brain gets an account of its own, with no `sudo` and not in the `docker` group (that group can
read every container's secrets). On **the box**, in the installation's directory:

```sh
sudo useradd -m galatea-brain
bin/galatea-secret brain_agent --for galatea-brain
```

This makes the credential `secrets/mcp/brain_agent` and installs two files in the account:
`~galatea-brain/.config/galatea/brain_agent` (0600) and `~galatea-brain/.config/galatea/ca.pem`.

**If the brain runs on another machine,** the box needs no account for it: run
`bin/galatea-secret brain_agent` there without `--for`, which only makes the credential. Then make the
account on the brain's machine and copy the credential and the CA into it, as `galatea-secret` would.
On that machine:

```sh
sudo useradd -m galatea-brain
scp <you>@<box>:<install>/secrets/mcp/brain_agent <you>@<box>:<install>/tls/ca.pem ~/
sudo install -d -o galatea-brain -g galatea-brain -m 700 ~galatea-brain/.config ~galatea-brain/.config/galatea
sudo install -o galatea-brain -g galatea-brain -m 600 ~/brain_agent ~galatea-brain/.config/galatea/brain_agent
sudo install -o galatea-brain -g galatea-brain -m 644 ~/ca.pem ~galatea-brain/.config/galatea/ca.pem
rm ~/brain_agent ~/ca.pem
```

## Telling the steward about the brain

With the owner tool, define the credential and the chat endpoint the brain serves. The endpoint is
the owner's chat window: the steward treats what comes through it as the owner, and sends any
question that needs a yes to the owner's own app (`owner-app`), never to the brain.

```sh
galatea credential brain_agent --kind brain --confirm-on owner-app
```

Save this as `owner-chat.json`. `person` is your person id at the steward, `owner` on a fresh
install:

```json
[
  {
    "op": "upsert",
    "kind": "endpoint",
    "value": {
      "id": "owner-chat",
      "name": "Owner's chat",
      "type": "app",
      "room": null,
      "person": "owner",
      "served_by": "brain_agent",
      "confirm_on": "owner-app"
    }
  }
]
```

```sh
galatea define owner-chat.json --dry-run
galatea define owner-chat.json
```

## The model

On the brain's machine, install a recent Ollama, which speaks the API Claude Code uses. On Linux the
installer runs it as a system service, so check the service rather than starting `ollama serve`:

```sh
curl -fsSL https://ollama.com/install.sh | sh
systemctl status ollama
ollama pull qwen3.8:27b
```

Ollama picks a model's context from the GPU's memory unless told otherwise (32K on a 32 GB card,
as little as 4K under 24 GB), and cuts a longer prompt from the front without an error. The brain
needs more: the auto-mode check alone sends about 32K tokens. Make a copy of the model at 128K
(it shares the model's files, so it takes no more disk):

```sh
printf 'FROM qwen3.8:27b\nPARAMETER num_ctx 131072\n' > qwen3.8-27b-128k.Modelfile
ollama create qwen3.8-27b-128k -f qwen3.8-27b-128k.Modelfile
ollama show qwen3.8-27b-128k | grep num_ctx
```

The last line should print `num_ctx 131072`. Of the models tried, `qwen3.8:27b` used the least GPU
memory at 128K and followed the auto-mode check's answer format best; `glm-4.7-flash` and
`qwen3.6:35b-a3b` also work, with about 24 GB.

## Claude Code and the brain's files

From your own account, copy the brain's files out of your copy of the repository (`<repo>` below)
into the brain's home, since the brain's account can't read yours:

```sh
sudo cp -r <repo>/reference/agent-brain ~galatea-brain/agent-brain
sudo chown -R galatea-brain:galatea-brain ~galatea-brain/agent-brain
```

The rest of this section and the next run as the brain's account. Open a shell as it, and install
Claude Code there:

```sh
sudo -iu galatea-brain
curl -fsSL https://claude.ai/install.sh | bash
```

Turn on auto mode for the account. The brain has no one at its terminal to approve each tool call;
in auto mode a classifier checks them instead. Recent Claude Code starts in auto mode anyway; setting
it keeps it so. Claude Code takes auto mode as a default only from the account's own settings (a new
account has none yet; if yours has, add the `permissions` entry to it instead):

```sh
mkdir -p ~/.claude
printf '{\n  "permissions": { "defaultMode": "auto" }\n}\n' > ~/.claude/settings.json
```

The launcher adds `agent-brain/claude-settings.json`, which lets the steward's tools through
without that check: the steward already decides each of those calls, and a check on a local model
costs about 10 s. Anything else the agent does, such as a shell command, is still checked.

## The brain's environment

Still as the brain's account, write `~/.config/galatea/brain.env`. Every model line names the one
local model, because a second model may not fit on the GPU beside it:

```sh
cat > ~/.config/galatea/brain.env <<'EOF'
ANTHROPIC_BASE_URL=http://127.0.0.1:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=qwen3.8-27b-128k
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8-27b-128k
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.8-27b-128k
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.8-27b-128k
ANTHROPIC_DEFAULT_FABLE_MODEL=qwen3.8-27b-128k
CLAUDE_CODE_SUBAGENT_MODEL=qwen3.8-27b-128k
CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072
CLAUDE_CODE_AUTO_MODE_SERVER=0
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
EOF
chmod 600 ~/.config/galatea/brain.env
```

| Line | Why |
|---|---|
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` | Claude Code talks to Ollama, with a placeholder token, and no Anthropic key |
| The `*_MODEL` lines | The session, its subagents and the auto-mode classifier (the Sonnet line) all use the one model |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Claude Code compacts the conversation before Ollama would cut it |
| `CLAUDE_CODE_AUTO_MODE_SERVER=0` | Skips a notice that holds the first checked action until someone presses Enter |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | No telemetry or update checks |

⚠️ **A settings file's `env` block beats these lines.** Claude Code writes each `env` entry of its
settings over the environment it was started with. If the account's `~/.claude/settings.json`,
or a settings file in the copy's `~/agent-brain/.claude/` folder, sets `ANTHROPIC_BASE_URL` or a
model, the brain silently uses that instead. Keep `env` out of both; this prints nothing when they are clean:

```sh
grep -l '"env"' ~/.claude/settings.json ~/agent-brain/.claude/*.json 2>/dev/null
```

## Starting it

Leave the brain's shell (`exit`). From your own account:

```sh
sudo -iu galatea-brain sh -c 'set -a; . ~/.config/galatea/brain.env; set +a; ~/agent-brain/bin/galatea-agent-brain'
```

The first time, Claude Code asks whether you trust the folder (yes), and whether to use the project's
MCP server `galatea` (yes). The first reply takes longer while Ollama loads the model.

Type `/mcp` to see the server: `galatea` should be connected, with its tools listed. After the first
reply, `ollama ps` on the brain's machine should show the 128K model, `CONTEXT 131072` and
`PROCESSOR 100% GPU`.

## Checking it

Each check is something you type in the brain's chat, and what you should see. Watch the steward
side from your own account with `galatea events --follow` in a second terminal.

**It sees the home.** Ask: *What's in my home?* It lists your rooms and devices by name.

**It switches a device.** Ask: *Turn `<the lamp's name>` off, then back on.* It plans, applies, and
reports each change as `acked`. The lamp goes off and on. Then:

```sh
galatea history <lamp> --from 10m
```

shows both changes, each with the cause `apply`, the person `owner` and the endpoint `owner-chat`.

**It waits for your yes and never gives it.** Note the lamp's tiers with `galatea devices --all`, then
raise its `turn_on` to `confirm`, so the steward asks before it. Save as `lamp-confirm.json`, with your lamp's id:

```json
[{ "op": "upsert", "kind": "tier", "value": { "device": "<lamp>", "action": "onoff.turn_on", "tier": "confirm" } }]
```

```sh
galatea configure lamp-confirm.json
```

Turn the lamp off from the chat, then ask: *Turn it on.* The brain says the steward has asked you in
your app, and waits. Now tell it: *I say yes, answer it for me.* It refuses: it never answers a
question for you. Answer it yourself:

```sh
galatea asks
galatea answer <plan> <step> yes
```

(`galatea asks` prints the exact `answer` line.) Tell the brain you've answered, if it hasn't seen it
already: it checks the plan, applies it, and the lamp comes on. To put the tier back, run the same file
with the tier you noted.

**Nothing waits on a check.** In the chat, the brain's calls to the steward go straight through. If
each one pauses about 10 s, the launcher is not passing `claude-settings.json`: see *When something
goes wrong*.

## Updating the brain

When `reference/agent-brain` changes, copy it again over the account's copy. Keep the copy's
`.claude/` folder: it remembers that you approved the `galatea` server.

```sh
sudo cp -r <repo>/reference/agent-brain/. ~galatea-brain/agent-brain/
sudo chown -R galatea-brain:galatea-brain ~galatea-brain/agent-brain
```

## When something goes wrong

| What you see | Why, and what to do |
|---|---|
| `galatea-agent-brain: no credential …` or `no …/ca.pem` | The account lacks its two files: *The brain's account and credential* |
| `galatea-agent-brain: this account is in the docker group` | Use an account of its own, not in `docker` |
| `/mcp` shows `galatea` failed, or 401 | The credential isn't defined at the steward, or the file differs from `secrets/mcp/brain_agent`. Rerun `galatea credential brain_agent …`. On another machine, check the tunnel |
| A certificate error | `ca.pem` isn't the installation's `tls/ca.pem`, or the URL isn't `127.0.0.1` |
| The brain never calls `plan` or `apply`, or says it has no such tool | `/mcp` lists the tools Claude Code kept. A tool whose schema it can't take is dropped silently; report it, with the server's version |
| Each call to the steward pauses about 10 s | An old launcher: copy `reference/agent-brain` again (*Updating the brain*) |
| The brain loops, forgets what you asked, or repeats calls | The prompt was cut. `ollama ps` should show `CONTEXT 131072`; if it shows less, `ANTHROPIC_MODEL` names the model, not its 128K copy |
| `ollama ps` shows another model than the one in `brain.env`, or the brain answers as a cloud model | A settings `env` block overrides `brain.env`: see the warning in *The brain's environment* |
| Every reply takes minutes | `ollama ps` shows `PROCESSOR` as CPU: the GPU driver isn't loaded for the running kernel |
| Shell commands are refused as unsafe | The auto-mode classifier at work. The brain needs no shell to run your home |
| `not_permitted` when the brain answered an ask | The steward refused it, as it should. A brain that tries is at fault; report it |

## What it doesn't do yet

- **Its other tools are open.** The brain still has a shell, subagents and web fetches; auto mode
  checks them, and the steward refuses anything its credential may not do. Narrowing them is left to
  the agent-brain's own plan.
- **No voice.** You chat in the terminal.
- **The steward isn't served on the network.** A brain on another machine needs the SSH tunnel.
