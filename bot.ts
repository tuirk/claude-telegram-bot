import { Bot, Context } from "grammy";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

// --- Config ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
  ? Number(process.env.ALLOWED_USER_ID)
  : null;

let workDir = process.env.WORK_DIR || process.cwd();

// --- Bot setup ---
const bot = new Bot(TOKEN);

// Track active Claude processes so user can cancel
const activeJobs = new Map<number, { proc: ReturnType<typeof spawn>; aborted: boolean }>();

// Track session IDs per chat — persisted to disk so sessions survive restarts
const SESSIONS_FILE = resolve(import.meta.dir, "sessions.json");

function loadSessions(): Map<number, string> {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
      return new Map(Object.entries(data).map(([k, v]) => [Number(k), v as string]));
    }
  } catch {}
  return new Map();
}

function saveSessions(sessions: Map<number, string>) {
  const obj: Record<string, string> = {};
  for (const [k, v] of sessions) obj[String(k)] = v;
  writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
}

const sessions = loadSessions();

// --- Helpers ---
function isAllowed(ctx: Context): boolean {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (!ALLOWED_USER_ID) {
    console.log(`\n⚠ Message from unknown user ${userId} (@${ctx.from?.username})`);
    console.log(`  To lock down, set ALLOWED_USER_ID=${userId} in .env\n`);
    return true;
  }
  return userId === ALLOWED_USER_ID;
}

/** Split a long message into Telegram-safe chunks (max 4096 chars) */
function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

/** Run claude with session continuity via --resume/--session-id */
function runClaude(prompt: string, cwd: string, sessionId: string, isFirst: boolean): { proc: ReturnType<typeof spawn>; output: Promise<string> } {
  const args = ["-p", "--output-format", "text"];
  if (isFirst) {
    // First message: start a new session with a known ID
    args.push("--session-id", sessionId);
  } else {
    // Subsequent messages: resume that session
    args.push("--resume", sessionId);
  }

  const proc = spawn("claude", args, {
    cwd,
    shell: true,
    env: { ...process.env, PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Write prompt via stdin so long messages don't get truncated
  proc.stdin?.write(prompt);
  proc.stdin?.end();

  const output = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => errChunks.push(d));

    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      if (code === 0 || stdout) {
        resolve(stdout || "(no output)");
      } else {
        reject(new Error(stderr || `claude exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });

  return { proc, output };
}

// --- Commands ---
bot.command("start", async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(
    `Claude Code Telegram Bridge\n\n` +
    `Send any message and I'll forward it to Claude Code.\n\n` +
    `Commands:\n` +
    `/cd <path> — change working directory\n` +
    `/pwd — show current working directory\n` +
    `/new — start a fresh conversation\n` +
    `/cancel — abort running Claude process\n` +
    `/ping — check if bot is alive\n\n` +
    `Current dir: ${workDir}\n` +
    `Claude remembers context within a session. Use /new to reset.`
  );
});

bot.command("ping", async (ctx) => {
  if (!isAllowed(ctx)) return;
  const hasSession = sessions.has(ctx.chat.id);
  await ctx.reply(`Alive. Dir: ${workDir}\nSession: ${hasSession ? "active" : "none"}`);
});

bot.command("pwd", async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(workDir);
});

bot.command("new", async (ctx) => {
  if (!isAllowed(ctx)) return;
  sessions.delete(ctx.chat.id);
  saveSessions(sessions);
  await ctx.reply("Session cleared. Next message starts a fresh conversation.");
});

bot.command("cd", async (ctx) => {
  if (!isAllowed(ctx)) return;
  const newDir = ctx.match?.trim();
  if (!newDir) {
    await ctx.reply("Usage: /cd <path>");
    return;
  }
  const resolved = resolve(newDir);
  if (!existsSync(resolved)) {
    await ctx.reply(`Directory not found: ${resolved}`);
    return;
  }
  workDir = resolved;
  // Reset session when changing directory since context changes
  sessions.delete(ctx.chat.id);
  saveSessions(sessions);
  await ctx.reply(`Working dir: ${workDir}\nSession reset for new directory.`);
});

bot.command("cancel", async (ctx) => {
  if (!isAllowed(ctx)) return;
  const chatId = ctx.chat.id;
  const job = activeJobs.get(chatId);
  if (!job) {
    await ctx.reply("Nothing running.");
    return;
  }
  job.aborted = true;
  job.proc.kill("SIGTERM");
  activeJobs.delete(chatId);
  await ctx.reply("Cancelled.");
});

// --- Main message handler ---
bot.on("message:text", async (ctx) => {
  if (!isAllowed(ctx)) {
    await ctx.reply(`Access denied. Your user ID: ${ctx.from?.id}`);
    return;
  }

  const prompt = ctx.message.text;
  const chatId = ctx.chat.id;

  if (activeJobs.has(chatId)) {
    await ctx.reply("Claude is still working on your last message. /cancel to abort.");
    return;
  }

  // Get or create session
  const isFirst = !sessions.has(chatId);
  if (isFirst) {
    sessions.set(chatId, randomUUID());
    saveSessions(sessions);
  }
  const sessionId = sessions.get(chatId)!;

  console.log(`[${new Date().toLocaleTimeString()}] ${isFirst ? "NEW" : "CONT"} session=${sessionId.slice(0, 8)}... Prompt: ${prompt.slice(0, 80)}...`);

  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

  try {
    const { proc, output } = runClaude(prompt, workDir, sessionId, isFirst);
    activeJobs.set(chatId, { proc, aborted: false });

    const result = await output;
    activeJobs.delete(chatId);
    clearInterval(typingInterval);

    const chunks = splitMessage(result);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  } catch (err: any) {
    activeJobs.delete(chatId);
    clearInterval(typingInterval);
    const msg = err?.message || String(err);
    // If resume fails (session expired/corrupted), start fresh next time
    if (msg.includes("resume") || msg.includes("session")) {
      sessions.delete(chatId);
      await ctx.reply(`Session error — reset. Try your message again.\n\n${msg.slice(0, 500)}`);
    } else {
      await ctx.reply(`Error:\n${msg.slice(0, 2000)}`);
    }
  }
});

// --- Launch ---
console.log("Starting Claude Code Telegram bridge...");
console.log(`Working dir: ${workDir}`);
if (ALLOWED_USER_ID) {
  console.log(`Locked to user ID: ${ALLOWED_USER_ID}`);
} else {
  console.log("⚠ No ALLOWED_USER_ID set — will accept messages from anyone until you lock it down");
}
bot.start();
console.log("Bot is running. Send a message in Telegram.");
