# UAEU Blackboard MCP

An MCP server for **UAEU Blackboard Learn** (`https://uaeu.blackboard.com`) that gives an AI
assistant your courses, assignments, discussions, messages, calendar, groups, content and
grades — plus the write actions Blackboard actually permits for your role.

[Quick install](#quick-install--no-clone-or-build) · [Agent installation prompt](#agent-installation-prompt) ·
[Download v0.1.0](https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz)

It uses the same internal Ultra API the Blackboard web app calls, authenticated with your own
SSO session. No administrator-issued OAuth application is required.

```
$ uaeu-blackboard-mcp login
  A browser window is open. Sign in to UAEU Blackboard (SSO + MFA).

  Signed in as Example Student
  Instance:  https://uaeu.blackboard.com
  API mode:  internal
```

## Coverage

| Area | Read | Write | Live status |
|---|---|---|---|
| **Assignments** | instructions, deadlines, points, attempts, submission status, submission files | submit text/files, resubmit | read verified; submit implemented, needs one real attempt to confirm |
| **Discussions** | forums, threads, replies, authors, read state | create thread, reply, edit/delete own posts | read verified; create/reply payload captured from the UI |
| **Messages** | conversations, message history, per-course unread summary, recipient search | send message, reply | read verified; send payload captured from the UI |
| **Calendar** | deadlines and personal events, date filtering | create, update, delete personal events | create → list → delete verified end-to-end |
| **Groups** | groups, group sets, members, sign-up state | join (self sign-up), upload group file | read verified; writes experimental |
| **Profile & settings** | profile, editable-field permissions | update permitted profile fields, read notification prefs | read verified |
| **Course content (instructor)** | outline, modules, pages, files, visibility | create module/page, edit, show/hide, delete | read verified; writes require an instructor role |
| **Announcements (instructor)** | announcements, read state | create, schedule, edit, delete | read verified; writes require an instructor role |
| **Assessments (instructor)** | assessment list, settings, questions, rubrics | create assignment, change deadline, attach rubric | read verified; writes require an instructor role |
| **Grading (instructor)** | gradebook, grades, attempts, submissions | enter grades and feedback, grant extensions/exemptions | read verified; writes require a grading role |
| **Course management** | roster, roles, permissions | enroll, change role, remove member | read verified; writes require course management permission |

Instructor-only writes are implemented against Blackboard's documented request shapes but could
not be exercised from a student account. They fail closed with a permission error when your role
does not allow them.

## Reading files and course links

The local connector also provides these read-only tools:

| Tool | Purpose |
|---|---|
| `bb_get_course_content` | Find files and posted links across the outline, with created/modified dates |
| `bb_list_attachments` | Resolve downloadable files attached to a content item |
| `bb_get_attachment` | Download a file and return its extracted text, saved path and limitations |
| `bb_read_link` | Read a link posted in the specified course content or announcement |
| `bb_get_upcoming_work` | Combine upcoming deadlines and recently overdue work across courses |
| `bb_get_recent_updates` | Combine changed content, announcements, assignments and grades on changed columns |
| `bb_get_assignment_context` | Package assignment instructions, status, files, links, rubric associations and related announcements |

For example, find the newest lecture with `bb_get_course_content`, then pass its `courseId`
and `contentId` to `bb_get_attachment`. Continue long documents by returning `nextOffset`
as `offset`. Pages default to 20,000 characters. Extraction results are cached in memory
for ten minutes to make continuation calls cheap.

Supported files: PDF text by page, PPTX slides and speaker notes, DOCX paragraphs and notes,
XLSX as CSV per worksheet, Jupyter notebook source, HTML and plain text/code. Notebook cells
are never executed. Spreadsheets show cached formula results without recalculation. Images,
slide diagrams, scanned PDFs, animations and legacy `.ppt`/`.doc`/`.xls` formats are not
interpreted. Scans need a separate OCR reader. Files are limited to 50 MiB, expanded Office
XML to 100 MiB, and returned document text to two million characters; limits are reported.
Downloads go to `BB_DOWNLOAD_DIR`, defaulting to `Downloads/blackboard`, and keep the original
filename (with filesystem-invalid characters sanitized). If a different file already uses
that name, a numbered suffix is added, such as `Lecture (1).pptx`. Identical existing files
are reused. These tools never submit work or modify Blackboard.

`bb_read_link` verifies the URL against the supplied course source. Pass `contentId` or
`announcementId` for an exact source, or omit both to search that course's outline and first
100 announcements. It supports Google Docs/Slides/Sheets exports, Drive files, Colab notebooks,
ordinary web pages and linked files. Public same-origin HTML caption tracks can be read.
YouTube returns title/channel metadata, not a transcript. Zoom and other recording pages are
best-effort page text/captions; protected recording APIs, Syracuse-specific video services,
live meetings and interactive LTI tools are not implemented. Private files require access
on their own service. Sign in yourself from a terminal when needed:

```sh
node dist/cli.js connect google
node dist/cli.js connect zoom
```

The CLI opens a separate browser profile and saves linked-site cookies locally, separately
from Blackboard. It does not copy the user's Chrome profile. Google may refuse automated
sign-in. Sessions expire normally, and access failures are returned explicitly. Each HTTPS
redirect is checked, DNS is pinned to public addresses, and cookies stay domain/path scoped.

Upcoming work uses Asia/Dubai day boundaries and preserves unknown submission states.
Cross-course sweeps check at most 20 available courses and report skipped courses/source
failures. Recent update dates indicate edits as well as uploads; grades entered on unchanged
older columns can be missed. Deadlines outside Blackboard are not included.

After rebuilding an already-running MCP, reconnect the connector or restart its host so the
client discovers the new tools. Run `npm test` for the extraction/reading regression suite.

## Requirements

- Node.js 20 or newer
- Microsoft Edge or Google Chrome (used once, for the SSO sign-in)
- A UAEU Blackboard account

## Quick install — no clone or build

Install Node.js 20+ and Edge or Chrome, then sign in once:

```sh
npx --yes --package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz uaeu-blackboard-mcp login
```

Complete UAEU SSO and MFA in the browser that opens. The prebuilt package is downloaded from
this repository's GitHub release and cached by npm. It needs no Git installation or TypeScript
compiler. Each account signs in separately; students and instructors use the same package.

### Automatic client configuration with add-mcp

[`add-mcp`](https://github.com/neon-solutions/add-mcp) can register the released server
for you, without editing client configuration files. After signing in above, run this
on Windows to choose the client interactively:

```powershell
npx --yes add-mcp "cmd /d /c npx --yes --package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz uaeu-blackboard-mcp" --name uaeu-blackboard --global
```

On macOS or Linux:

```sh
npx --yes add-mcp "npx --yes --package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz uaeu-blackboard-mcp" --name uaeu-blackboard --global
```

To target a specific client without prompts, append `--agent codex --yes`.
Other client IDs include `claude-code`, `cursor`, `claude-desktop`, and `vscode`.
Omit `--global` to configure only the current project where the client supports it.
Writes stay disabled unless you append `--env BB_ALLOW_WRITES=1`; individual write
tools still require confirmation. Restart or reconnect the client after registration.
Registration saves the launch command; npm downloads the server when it runs.

### Codex

On Windows (PowerShell):

```powershell
codex mcp add uaeu-blackboard --env BB_ALLOW_WRITES=1 -- cmd /d /c npx --yes --package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz uaeu-blackboard-mcp
```

On macOS or Linux:

```sh
codex mcp add uaeu-blackboard --env BB_ALLOW_WRITES=1 -- npx --yes --package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz uaeu-blackboard-mcp
```

Check registration with `codex mcp get uaeu-blackboard`. Reopen Codex if needed, then ask it
to run `bb_whoami` and list your courses. The first download can take longer than a cached
launch; run the login command before registering the server so the package is already cached.

### Claude Code

On Windows:

```powershell
claude mcp add --scope user --env BB_ALLOW_WRITES=1 --transport stdio uaeu-blackboard -- cmd /d /c npx --yes --package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz uaeu-blackboard-mcp
```

On macOS or Linux, use the same command with `-- npx --yes ...` instead of
`-- cmd /d /c npx --yes ...`. Check registration with `claude mcp get uaeu-blackboard`.

### Cursor, Claude Desktop and other local MCP clients

Merge this entry into the client's `mcpServers` configuration. Cursor supports a user-wide
`~/.cursor/mcp.json`. Other clients can use their MCP settings screen to enter the same
command, arguments and environment. Existing server entries should remain intact.

```json
{
  "mcpServers": {
    "uaeu-blackboard": {
      "command": "npx",
      "args": ["--yes", "--package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz", "uaeu-blackboard-mcp"],
      "env": { "BB_ALLOW_WRITES": "1" }
    }
  }
}
```

On Windows, use `"command": "cmd"` and prepend `"/d", "/c", "npx"` to `args`.
If a client requires a transport field, set `"type": "stdio"`.

VS Code uses a `servers` wrapper in its MCP configuration instead of `mcpServers`. Use
**MCP: Add Server**, choose a local command, and enter the command above, or use:

```json
{
  "servers": {
    "uaeu-blackboard": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz", "uaeu-blackboard-mcp"],
      "env": { "BB_ALLOW_WRITES": "1" }
    }
  }
}
```

Apply the same Windows command adjustment when needed. This is a local stdio server;
clients that accept only remote HTTP servers need a separate local bridge.

Client references: [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp),
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Agent installation prompt

Copy this prompt into an AI coding agent that can run terminal commands and edit local settings:

```text
Install UAEU Blackboard MCP for the AI client I am using.
Repository: https://github.com/AhmTb/uaeu-blackboard-mcp
Package: https://github.com/AhmTb/uaeu-blackboard-mcp/releases/download/v0.1.0/uaeu-blackboard-mcp-0.1.0.tgz

1. Read this repository's README. Detect my OS and the current AI client. Check
   Node.js 20+, npm/npx, and Edge or Chrome. Report any missing prerequisite.
2. Run `npx --yes --package=<Package URL> uaeu-blackboard-mcp --help`
   to verify the prebuilt download works.
   Git and a TypeScript build are unnecessary for the release package.
3. Run `npx --yes --package=<Package URL> uaeu-blackboard-mcp login`.
   I will complete UAEU SSO and MFA in the
   browser. Wait for successful login. Keep passwords, cookies, tokens and the
   browser profile out of chat and MCP configuration.
4. Register a local stdio server named `uaeu-blackboard` for my current client
   with BB_ALLOW_WRITES=1. Use its supported configuration format, preserving
   existing entries. Prefer user scope. On Windows use command `cmd` with args
   `/d`, `/c`, `npx`, `--yes`, `--package=<Package URL>`, `uaeu-blackboard-mcp`.
   On macOS/Linux use command `npx` with args `--yes`, `--package=<Package URL>`,
   `uaeu-blackboard-mcp`. Set startup timeout to 60 seconds
   if the client supports it. Ask which client only if it cannot be detected.
5. Verify the saved server entry and a real MCP initialization. Run `bb_whoami`
   and `bb_list_courses` when the tools are available. Use read-only checks;
   leave submissions, messages, grades and other writes untouched during setup.
6. Report the configuration location and connection result. If the running
   client needs a restart, give the exact restart/reload step and distinguish
   saved configuration from tools actually available in this session.

Keep this setup limited to my client and account. The server's existing
confirm:true requirement remains enabled for write actions.
```

## Install from source

```powershell
git clone https://github.com/AhmTb/uaeu-blackboard-mcp.git
cd uaeu-blackboard-mcp
npm ci
npm run build
npm run login          # opens Edge; sign in with SSO + MFA
npm run doctor         # confirms the session and API surface
```

Each student or instructor signs in with their own UAEU account. The available actions follow
that account's Blackboard permissions; installing this server does not grant instructor access.

The session is stored at `~/.uaeu-blackboard-mcp/session.json` (on Windows,
`%USERPROFILE%\.uaeu-blackboard-mcp\session.json`). It contains live credentials and must stay private.
The login browser profile and `browser-session.json` are stored alongside it. The latter
preserves session-only SSO cookies across browser restarts. Keep all three private.

Before making a request, the server picks up newer sessions saved by another local process.
When a tool call finds a missing or expired session, it first tries the saved SSO browser
profile in a hidden browser for up to twenty seconds. If SSO can renew the session, the read
continues without a login prompt. Otherwise, an Edge or Chrome login window opens. Complete
SSO and MFA there; cookies are captured and saved automatically, and the interrupted read
retries once. No copied cookies or terminal command is needed.
Concurrent requests share one login window. Startup and background keep-alives do not open it.
Closing the window or failing to sign in within ten minutes returns an error; call the tool again
to retry. Writes are never replayed automatically after sign-in; check Blackboard before retrying.
You can still sign in explicitly with `npm run login`.
The server pings a keep-alive endpoint while it is running and saves renewed cookie expiry
times. Blackboard and UAEU still control session lifetimes and when MFA is required.

### Remember your login and control automatic sign-in

To remember your username and password, sign in once with:

```powershell
npm run login -- --remember
```

This opts into saving credentials submitted during a successful browser sign-in in the
operating system's credential store: Windows Credential Manager, macOS Keychain, or Linux
Secret Service. The [keyring binding](https://github.com/Brooooooklyn/keyring-node) handles
OS storage; passwords are never written to the session JSON, settings, logs, or environment.
Linux requires an unlocked Secret Service; remembering fails without a plaintext fallback.
If the browser goes straight through existing SSO without showing a password form, there
is no password to capture. It will be remembered the next time you enter it successfully.

When a session expires, the server tries saved SSO first, then the remembered login. It
fills and submits supported Blackboard, Microsoft, and UAEU ADFS login forms. Passwords
are supplied only to the exact HTTPS origin where they were originally submitted; other
university identity providers can be explicitly allowed with `BB_LOGIN_ORIGINS`.
University-enforced MFA, CAPTCHA, password changes, and account selection can still need
your input. After an unsuccessful or interrupted password attempt, automatic password
submission pauses until a successful manual sign-in validates the credentials again.

```powershell
node dist/cli.js auto-login off     # stop automatic recovery and password capture/use
node dist/cli.js auto-login on      # enable recovery and remembering the next login
node dist/cli.js auto-login status  # inspect settings without exposing credentials
node dist/cli.js auto-login forget  # disable recovery and delete the saved password
```

You can also ask your assistant to enable or disable automatic sign-in using
`bb_set_auto_login` (`enabled: true/false`, optional `forget: true` when disabling).
`bb_get_login_settings` reports the effective setting and saved-login availability.
These local settings take effect on subsequent recovery attempts without restarting the
server and are separate from Blackboard write permissions. An explicit `BB_AUTO_LOGIN=0`
or `1` overrides the saved on/off preference. With automatic sign-in off, an existing API
session still works, and `login` remains available for manual sign-in. Forgetting the
password leaves the existing session cookies and browser profile in place.

### Headless / CI sign-in

Copy the `Cookie:` header from any request to `uaeu.blackboard.com` in DevTools and run:

```powershell
node dist\cli.js login --cookie "BbRouter=...; JSESSIONID=..."
```

## Connect it to your assistant

Add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "uaeu-blackboard": {
      "command": "node",
      "args": ["/absolute/path/to/uaeu-blackboard-mcp/dist/index.js"],
      "env": {
        "BB_ALLOW_WRITES": "1"
      }
    }
  }
}
```

Replace the example path with the absolute path to your cloned repository. On Windows, use
forward slashes such as `C:/path/to/uaeu-blackboard-mcp/dist/index.js`, or escape backslashes
in JSON. The server uses stdio, so the client starts it automatically.

For Codex, run this from the cloned repository after building and signing in:

```powershell
codex mcp add uaeu-blackboard --env BB_ALLOW_WRITES=1 -- node "$((Get-Location).Path)/dist/index.js"
```

Or edit Codex's `~/.codex/config.toml`:

```toml
[mcp_servers.uaeu-blackboard]
command = "node"
args = ["/absolute/path/to/uaeu-blackboard-mcp/dist/index.js"]
env = { BB_ALLOW_WRITES = "1" }
```

Without `BB_ALLOW_WRITES=1` the server is read-only and refuses every write action.
Restart your MCP client if the tools are not visible after adding the configuration. Start with
`bb_whoami` or ask your assistant to list your courses to check the connection.

## Write safety

Every write tool requires **both**:

1. `BB_ALLOW_WRITES=1` in the server environment, and
2. `confirm: true` in the individual tool call.

Without the flag, the tool returns:

```
Write actions are disabled. Set BB_ALLOW_WRITES=1 in the MCP server environment to enable them.
```

Without confirmation:

```
Refusing to submit this assignment without confirmation. Pass confirm: true to proceed.
```

Submitting an assignment, sending a message or entering a grade has real consequences. Review the
arguments before confirming.

## Tool catalogue

**Courses and identity** — `bb_whoami`, `bb_list_courses`, `bb_get_course`, `bb_list_terms`

**Assignments** — `bb_list_assignments`, `bb_get_assignment`, `bb_get_assignment_submission`,
`bb_submit_assignment`

**Discussions** — `bb_list_discussions`, `bb_get_discussion`, `bb_get_discussion_thread`,
`bb_create_discussion_thread`, `bb_reply_to_discussion`, `bb_edit_discussion_post`,
`bb_delete_discussion_post`

**Messages** — `bb_list_conversations`, `bb_get_conversation`, `bb_message_summary`,
`bb_send_message`, `bb_reply_message`, `bb_find_recipients`

**Calendar** — `bb_list_calendar`, `bb_create_calendar_event`, `bb_update_calendar_event`,
`bb_delete_calendar_event`

**Groups** — `bb_list_groups`, `bb_get_group`, `bb_list_group_members`, `bb_join_group`,
`bb_upload_group_file`

**Profile** — `bb_get_profile`, `bb_update_profile`, `bb_get_notification_prefs`

**Course content** — `bb_list_content`, `bb_browse_course`, `bb_get_content`, `bb_create_module`,
`bb_create_page`, `bb_update_content`, `bb_set_content_visibility`, `bb_delete_content`

**Announcements** — `bb_list_announcements`, `bb_create_announcement`, `bb_update_announcement`,
`bb_delete_announcement`

**Assessments** — `bb_list_assessments`, `bb_get_assessment`, `bb_create_assignment`,
`bb_set_assignment_deadline`, `bb_list_rubrics`, `bb_attach_rubric`

**Grading** — `bb_get_gradebook`, `bb_get_my_grades`, `bb_list_column_attempts`, `bb_get_attempt`,
`bb_grade_submission`, `bb_set_grade_exception`

**Course management** — `bb_list_roster`, `bb_add_member`, `bb_update_member_role`,
`bb_remove_member`

**Escape hatch** — `bb_raw_request` (any `/learn/api/...` path; GET is always allowed)

Most tools accept a `courseId` that can be an internal id (`_12345_1`), a course code
(`COURSE101_12345_Fall_2026`), or a unique name fragment (`"algorithms"`).

## Configuration

| Variable | Meaning |
|---|---|
| `BB_URL` | Instance origin, default `https://uaeu.blackboard.com` |
| `BB_ALLOW_WRITES` | `1` enables write tools (still require `confirm: true`) |
| `BB_STATE_DIR` | Session directory, default `%USERPROFILE%\.uaeu-blackboard-mcp` |
| `BB_AUTO_LOGIN` | Optional `0`/`false` or `1`/`true` override for automatic session recovery. Default uses the saved preference (initially enabled, without password storage) |
| `BB_LOGIN_ORIGINS` | Comma-separated additional exact HTTPS origins permitted for opt-in login capture/refill; never wildcard domains |
| `BB_PAGE_SIZE` | Default list page size, 1–200, default 50 |
| `BB_TIMEOUT_MS` | Total timeout per HTTP request including retries and backoff, default 30000 |
| `BB_CACHE_TTL_MS` | Identity, membership and outline cache lifetime, default 15000; 0 disables caching |
| `BB_CONCURRENCY` | Parallel outline folder reads, default 4; range 1–8 |
| `BB_LOG_LEVEL` | `silent`, `error`, `warn`, `info`, `debug` |
| `BB_COOKIE` | Cookie header for non-interactive login |

## Performance and response size

- Identical simultaneous JSON reads share one HTTP request. Each caller receives an independent
  object. Raw/download responses are never shared.
- Identity, memberships and outline pages use a bounded, in-memory cache (up to 64 responses).
  Every write clears cached reads before and after its request, including failed writes. Grades,
  assignment detail, raw requests and `bb_whoami` are fresh reads by default.
- Course traversal reads up to `BB_CONCURRENCY` folders together, follows folder pagination,
  deduplicates items and rejects pagination loops instead of silently returning incomplete results.
- Assignment detail and submission preparation fetch the specific assignment directly rather than
  traversing the entire course.
- JSON output is compact. `bb_list_assignments` defaults to 50 summaries without instruction
  bodies; pass `limit`, `offset`, or `includeInstructions: true` as needed. Responses expose
  `total` and `nextOffset` so more results can be requested explicitly.
- `bb_get_assignment` returns its normalized details; use `includeRaw: true` for the full original
  response. `bb_list_content` accepts `limit`, `offset` and `includeDescriptions: true`, and returns
  continuation information. `bb_browse_course` accepts `limit`/`offset` with `total`/`nextOffset`.

Transient GET failures retry up to three times within one timeout budget, respecting numeric or
HTTP-date `Retry-After`. Writes are sent once: a lost response could mean Blackboard already
performed the action. Connection failures report an unknown outcome rather than replaying a write.
Submission files are checked before an attempt is created; failures after creation identify the
attempt to inspect before trying again. Expired sessions and outages are surfaced instead of being
converted to empty assignment lists.

## How it works

Blackboard exposes two API surfaces:

- `/learn/api/public/v1` — the documented REST API. It requires an OAuth application registered by
  the institution, which students and most staff cannot obtain.
- `/learn/api/v1` — the internal Ultra API used by the web client. It authenticates with the
  `BbRouter` session cookie from SSO.

Both surfaces accept the `BbRouter` session on this instance. The server uses the internal Ultra
API for data the public API does not expose (discussions, conversations, calendar, Ultra content),
and the documented public API for documented CRUD (announcements, content, gradebook, enrollments).
Write requests carry the `x-blackboard-xsrf` token, which is embedded in the `BbRouter` cookie
value, so no extra bootstrap request is needed.

At sign-in the server probes both surfaces and records the result; `npm run doctor` shows both.

## Verification

Live-verified against `uaeu.blackboard.com` running Blackboard Learn **4001.4.0**, with a student
account:

- authentication, enrolled courses, terms
- assignments with real deadlines, points, attempts and submission state
- discussion forums, threads and replies (including a correctly denied restricted forum)
- conversations and message history
- calendar deadlines and personal events
- groups, roster, profile, gradebook, content outline
- personal calendar create → list → delete (test event removed afterwards)

The server speaks MCP over stdio. Startup, tool discovery and student reads have been verified.
Instructor writes and assignment submission still require verification with the corresponding role.

## Security and privacy

- Session credentials are stored locally and sent to the configured Blackboard host for authentication.
- The session file and login browser profile contain live credentials; keep their directory private.
- Tool results are passed to your connected AI client. Its data handling settings apply to that content.
- Reads are limited to what your account can already see in the browser; Blackboard enforces
  permissions on every request.
- Writes are disabled unless explicitly enabled, and each one needs confirmation.
- Grades and feedback are personal data. Only request what you need.

## Limitations

- This is an **unofficial** integration. Blackboard can change the internal API without notice.
- On expiry, the next tool call tries saved SSO and opt-in remembered credentials before opening an interactive login window, unless automatic sign-in is disabled.
- Ultra courses expose the full tool set. Classic courses expose less; `bb_raw_request` is the
  fallback.
- Group join/upload and instructor write paths are experimental until exercised with the relevant
  role.
- Assignment submission is implemented as attempt → upload → post. Confirm the result in
  Blackboard the first time you use it.

## Troubleshooting

**Missing or expired session** — a tool call tries saved SSO, then opens a login window if needed. Sign in there
and the read resumes. If the window was closed, call the tool again. If browser launch is blocked,
run `npm run login` on the same machine or use the headless sign-in command above.

**`Your Blackboard account is not permitted to perform this action`** — the tool needs a role your
account does not have (for example grading as a student), or the item is restricted.

**A discussion returns 403** — the forum exists but is hidden from you by adaptive release or group
membership.

**`spawn EPERM` during login** — the environment blocks browser processes; use `login --cookie`
with a copied cookie header instead.

## Development

```powershell
npm run build       # tsc
npm run typecheck
node dist\cli.js doctor
```

Source layout:

```
src/
  index.ts            MCP server and tool registration
  cli.ts              login / status / probe / doctor
  auth/login.ts       Playwright SSO capture
  bb/client.ts        HTTP client, cookies, XSRF, pagination, retries
  bb/api.ts           Blackboard domain operations
  tools/*.ts          One module per feature area
```

## Legal

Not affiliated with or endorsed by United Arab Emirates University, Anthology or Blackboard.
Use it with your own account and within UAEU's acceptable-use policy.
