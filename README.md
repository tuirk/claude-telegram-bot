# Claude Code Telegram Bot

Control [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone via Telegram. Your computer does the work — you just send messages from wherever you are.

## What This Does

A lightweight bridge between Telegram and the Claude Code CLI. You send a message to your Telegram bot, it runs `claude` on your machine, and sends back the response. Claude remembers context within a session, just like the normal CLI.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- [Bun](https://bun.sh) runtime
- A Telegram account

## Setup

### 1. Create Your Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Pick a display name and a username (must end in `bot`)
4. Copy the API token it gives you

### 2. Install & Configure

```bash
git clone https://github.com/tuirk/claude-telegram-bot.git
cd claude-telegram-bot
bun install
cp .env.example .env
```

Edit `.env` and paste your bot token.

### 3. Run

```bash
bun run bot.ts
```

### 4. Lock It Down

Send any message to your bot in Telegram. The terminal will print:

```
⚠ Message from unknown user 123456789 (@yourname)
  To lock down, set ALLOWED_USER_ID=123456789 in .env
```

Copy that number into `.env` as `ALLOWED_USER_ID` and restart the bot. Now only you can use it.

## Usage

| Telegram Command | What It Does |
|---|---|
| _any text_ | Sends your message to Claude Code and replies with the response |
| `/cd <path>` | Change the working directory (resets conversation) |
| `/pwd` | Show current working directory |
| `/new` | Start a fresh conversation |
| `/cancel` | Abort a running Claude request |
| `/ping` | Check if the bot is alive |

### Example

```
You: /cd ~/my-project
Bot: Working dir: /home/you/my-project. Session reset for new directory.

You: what does the main function do?
Bot: The main function in src/index.ts initializes the Express server...

You: add error handling to it
Bot: I've updated src/index.ts with try-catch blocks around...
```

## How It Works

- Each message runs `claude -p` with a session ID so Claude remembers earlier messages
- Long prompts are piped via stdin (no shell argument length limits)
- Long responses are automatically split into multiple Telegram messages
- Changing directory with `/cd` resets the session since the project context changes

## Permissions (Optional)

By default, Claude Code asks for permission before running commands. If you're away from the terminal, those prompts will block.

To auto-approve safe commands, create `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(find *)",
      "Bash(grep *)",
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(python *)",
      "Bash(node *)",
      "Edit",
      "Write"
    ]
  }
}
```

Add or remove patterns to match your workflow. Anything **not** listed will still require terminal approval.

See [Claude Code permissions docs](https://docs.anthropic.com/en/docs/claude-code/settings) for the full reference.

## Good to Know

- **Your computer must stay on** — this is a remote control, not a cloud service
- **Sessions survive restarts** — session IDs are saved to `sessions.json`, so restarting the bot resumes where you left off. Use `/new` to start fresh
- **Security** — messages pass through Telegram's servers. Don't send passwords, API keys, or secrets through the bot
- **Typing indicator** — Telegram shows "typing..." while Claude works on a response
- **Photos** — not supported yet (text only)

## License

MIT
