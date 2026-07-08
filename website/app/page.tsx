import { Bunny, BunnyPeek } from '../components/Bunny';
import { CopyButton } from '../components/CopyButton';
import { DemoVideo } from '../components/DemoVideo';

const REPO = 'https://github.com/shlokkhemani/rabbithole';

const CMD_CLAUDE = 'claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole';
const CMD_CODEX = 'codex mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole';
const CODEX_CONFIG = `[mcp_servers.rabbithole]
command = "npx"
args = ["-y", "github:shlokkhemani/rabbithole"]
tool_timeout_sec = 600`;
const CMD_JSON = `{
  "mcpServers": {
    "rabbithole": {
      "command": "npx",
      "args": ["-y", "github:shlokkhemani/rabbithole"]
    }
  }
}`;

const LAZY_PROMPT = `Set up Rabbithole for me from https://github.com/shlokkhemani/rabbithole — the README has exact steps written for you, an agent. When it's installed, ask me for a document to open.`;

const AGENT_STEPS = `1. Check the runtime: node --version   (needs >= 18)

2. Register the MCP server — pick the client you are running inside:

   Claude Code   claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
   Codex         codex mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
                 then edit ~/.codex/config.toml:
                 [mcp_servers.rabbithole]
                 command = "npx"
                 args = ["-y", "github:shlokkhemani/rabbithole"]
                 tool_timeout_sec = 600
   anything else add to the client's MCP config:
                 { "command": "npx", "args": ["-y", "github:shlokkhemani/rabbithole"] }

   No clone, no build — npx fetches the repo and runs bin/mcp-server.js
   over stdio. The first run takes ~20s; it's cached after that.
   Note: codex mcp add cannot set tool_timeout_sec.

3. Reconnect, then verify these four tools exist:
   open_rabbithole · answer_branch · ingest_pdf · list_rabbitholes

4. Tell your human to say: "open <document> in rabbithole"
   You call open_rabbithole with { title, content } — it opens their browser
   and BLOCKS until they select text and ask. That's a long-poll, not a hang.
   Answer with answer_branch: stream 1-3 sentence chunks with partial: true,
   finish with a titled final call, loop until status = 'session_closed'.
   If a wait returns status = 'keep_listening', immediately call
   open_rabbithole with the returned { hole_id }; do not re-send content.

Headless? RABBITHOLE_NO_BROWSER=1 skips auto-opening the browser.
Storage lives in ~/.rabbithole (override: RABBITHOLE_DIR).`;

export default function Page() {
  return (
    <div className="wrap">
      <nav className="nav">
        <a className="wordmark" href="/">
          <span className="mark">
            <Bunny size={21} />
          </span>
          rabbit<span className="burrow">hole</span>
        </a>
        <div className="nav-links">
          <a href="#how" className="hide-sm">
            how it works
          </a>
          <a href="#install">install</a>
          <a href="#agents" className="hide-sm">
            for agents
          </a>
          <a href={REPO}>GitHub</a>
        </div>
      </nav>

      <header className="hero">
        <h1>
          chat is a straight line.
          <br />
          your <span className="accent">curiosity</span> isn&rsquo;t.
        </h1>
        <p className="hero-sub">
          Rabbithole is an infinite canvas for learning. Open any document,
          select what makes you curious, ask — and the answer opens as a new
          document beside it. Powered by the agent you already use.
        </p>
        <div className="cta-row">
          <a className="btn btn-primary" href="#install">
            install in 60 seconds
          </a>
          <a className="btn btn-ghost" href={REPO}>
            star on GitHub
          </a>
        </div>
        <div className="stage">
          <DemoVideo
            src="/demo-ask.mp4"
            poster="/demo-ask-poster.jpg"
            label="Rabbithole demo: selecting text in a document, asking, and the answer opening as a new document"
          />
        </div>
        <p className="stage-caption">
          select anything, <span className="accent">ask</span> anything.
        </p>
      </header>

      <section id="how">
        <h2>every document becomes a canvas</h2>
        <p className="section-sub">
          No new app to learn, no new AI to subscribe to. Rabbithole is a
          canvas your own agent draws on — free, open source, entirely on your
          machine.
        </p>
        <div className="steps">
          <div className="step">
            <div className="step-num">01</div>
            <h3>open</h3>
            <p>
              Tell your agent <em>&ldquo;open this in rabbithole.&rdquo;</em> A
              paper, a README, notes, anything — it becomes a living document
              in your browser.
            </p>
          </div>
          <div className="step">
            <div className="step-num">02</div>
            <h3>ask</h3>
            <p>
              Select any phrase that snags you. Ask your own question, or tap
              a lens and keep reading.
            </p>
            <div className="kbd-row">Explain · ELI5 · Example · Go Deeper</div>
          </div>
          <div className="step">
            <div className="step-num">03</div>
            <h3>descend</h3>
            <p>
              The answer streams in as a child document — just as alive as the
              first. Select, ask, branch again. Recurse forever.
            </p>
          </div>
        </div>
      </section>

      <section id="map">
        <h2>
          your curiosity becomes a <span className="accent">map</span>
        </h2>
        <p className="section-sub">
          Zoom out and your whole line of thought is laid out — every branch
          attached to the exact words that sparked it. Holes save themselves;
          come back tomorrow and pick up the thread right where you left it.
        </p>
        <div className="stage" style={{ marginTop: 48 }}>
          <DemoVideo
            src="/demo-map.mp4"
            poster="/demo-map-poster.jpg"
            label="Rabbithole demo: zooming out to a map of branching documents"
          />
        </div>
      </section>

      <section id="install">
        <h2>install in 60 seconds</h2>
        <p className="install-note">
          You need Node 18+, a browser, and an agent — Claude Code, Codex, or
          any MCP client. No account, no API keys, nothing leaves your machine.
        </p>

        <div className="lazy-card">
          <div className="label">the lazy way — recommended</div>
          <p className="lede">
            Don&rsquo;t run commands. Paste this to your agent and let it do
            the work:
          </p>
          <div className="codebox">
            <pre className="wrap">{LAZY_PROMPT}</pre>
            <CopyButton text={LAZY_PROMPT} />
          </div>
        </div>

        <div className="install-grid">
          <div className="install-block">
            <div className="head">
              <span className="name">Claude Code</span>
              <span className="hint">one line, done</span>
            </div>
            <div className="codebox">
              <pre>
                <span className="tok">claude</span> mcp add rabbithole -- npx
                -y github:shlokkhemani/rabbithole
              </pre>
              <CopyButton text={CMD_CLAUDE} />
            </div>
            <p className="hint">Default stdio timeout is fine.</p>
          </div>

          <div className="install-block">
            <div className="head">
              <span className="name">Codex</span>
              <span className="hint">one line + config</span>
            </div>
            <div className="codebox">
              <pre>
                <span className="tok">codex</span> mcp add rabbithole -- npx
                -y github:shlokkhemani/rabbithole
              </pre>
              <CopyButton text={CMD_CODEX} />
            </div>
            <p className="hint">
              Then add this in <code>~/.codex/config.toml</code>;{' '}
              <code>codex mcp add</code> cannot set the timeout.
            </p>
            <div className="codebox">
              <pre>{CODEX_CONFIG}</pre>
              <CopyButton text={CODEX_CONFIG} />
            </div>
          </div>

          <div className="install-block">
            <div className="head">
              <span className="name">any MCP client</span>
              <span className="hint">add to its MCP config</span>
            </div>
            <div className="codebox">
              <pre>{CMD_JSON}</pre>
              <CopyButton text={CMD_JSON} />
            </div>
          </div>
        </div>

        <div className="then-say">
          <div className="label">then, in a new session, just say</div>
          <div className="chat-line">
            open this document in rabbithole<span className="caret"> ▍</span>
          </div>
          <p className="install-note" style={{ marginTop: 18 }}>
            First run takes ~20 seconds while npx fetches the repo — cached
            after that. Your holes live in <code>~/.rabbithole</code>.
          </p>
        </div>
      </section>

      <section id="agents">
        <h2>are you an agent?</h2>
        <p className="section-sub">
          If a human sent you here to set up Rabbithole: welcome — this part
          is written for you. It&rsquo;s also served plain at{' '}
          <a href="/llms.txt">/llms.txt</a>.
        </p>
        <div className="agent-card">
          <div className="head">setup — follow exactly</div>
          <pre>{AGENT_STEPS}</pre>
        </div>
      </section>

      <footer>
        <div className="burrow-scene">
          <BunnyPeek width={110} />
        </div>
        <div className="foot-row">
          <span className="foot-tag">
            go deeper. never lose the thread.
          </span>
          <span>
            <a href={REPO}>GitHub</a>
            {' · '}
            <a href="/llms.txt">llms.txt</a>
            {' · '}
            MIT · local-first
          </span>
        </div>
      </footer>
    </div>
  );
}
