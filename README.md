# PingRoom human review starter

Add a human approval step to a script or AI agent. The script sends a question to your phone, waits for your answer, and executes an allowlisted action only after you approve the exact proposal.

Uses the official [`@pingroom/sdk`](https://github.com/pingroom/sdk), pinned to `0.7.0`. Requires Node.js 22 or newer.

## Try it offline

Click **Use this template** on GitHub, clone your new repository, and run:

```sh
npm ci
npm run demo
```

No account, token, or network access is needed after installation. The real SDK runs against an in-memory HTTP transport: a simulated Deny skips execution; a simulated Approve creates a text file inside ignored `output/`.

## Connect your phone

Install or open [PingRoom](https://pingroom.io/i) and sign in, then run:

```sh
npm run connect
npm start
```

Open the connection link printed by `connect` and approve the robot's access to your room. Keep using that same link while installing the app. Credentials are saved in ignored `.pingroom/credentials.json` with owner-only file permissions (`0600`) on POSIX systems. Windows uses its filesystem permissions; keep the checkout in your private user directory.

`npm start` asks permission to create `output/release-note.txt`. Tap **Approve** to write it, or **Deny** to skip. A repeat run never overwrites an existing draft: choose a new filename in `src/draft.js` or remove your old sample draft first.

Already have an agent token? Export both `PINGROOM_TOKEN` and `PINGROOM_ROOM`, or copy `.env.example` to `.env` and fill in both. `npm start` loads `.env`; existing shell variables take precedence. If either variable is present, both are required and the saved credentials are ignored. Keep tokens outside source control.

## Add it to your workflow

The reusable module is [`src/review.js`](src/review.js). It accepts an injected SDK client and a callback supplied by your application:

```js
import { PingRoom } from '@pingroom/sdk';
import { reviewThenExecute } from './src/review.js';
import { writeDraft } from './src/draft.js';

// Your model or script may propose this payload. Application code validates it.
const proposal = {
  action: 'write_draft',
  filename: 'weekly-report.txt',
  content: 'The weekly report is ready for review.',
};

const result = await reviewThenExecute({
  client: new PingRoom({ token: process.env.PINGROOM_TOKEN }),
  room: process.env.PINGROOM_ROOM,
  proposal,
  timeoutMs: 120_000,
  execute: writeDraft,
});

console.log(result.executed ? 'Draft written' : 'Skipped');
```

To adapt this example, change `validateProposal`, the visible question, and the allowlisted handler together. Keep rules and execution in application code. A model may propose typed input; it cannot approve its own action or supply code to execute. This starter has no AI-provider dependency and never evaluates model-generated commands.

`requestReview(...)` is available when you only need the review result. It returns `approved`, `state`, `answer`, `questionId`, `proposalHash`, and the frozen `proposal`. Prefer `reviewThenExecute(...)` when you need the callback gated automatically.

## How the gate behaves

- The full draft, within the sample's size limits, is visible in the question. A SHA-256 hash binds the validated, immutable snapshot to the question, along with a unique review attempt and matching prompt and context.
- Only `state === 'answered'` with `answer.value === 'approve'`, matching question identity and data, direct responder scope, and a future expiry can execute.
- Deny, expiry, and cancellation return `executed: false`. Invalid responses, transport errors, local timeout, and caller abort throw before execution.
- Pass an `AbortSignal` to cancel. The sample handles Ctrl+C and termination signals. The two-minute default deadline covers creation and waiting; server expiry is at least 30 seconds.
- Remote cancellation is best effort. A late successful create is also withdrawn while this process remains alive. If the process exits or the network fails, the question may remain until its TTL, but a late answer cannot resume this invocation.
- Each invocation has a fresh review ID. This starter does not persist execution state or provide exactly-once execution across restarts. For consequential actions, persist the proposal, approval, and execution record; recheck relevant state and make the handler idempotent.

## Checks and troubleshooting

```sh
npm test
```

Tests use the real SDK with offline transport and cover approval, denial, expired/cancelled questions, mismatched responses, mutation, deadlines, aborts, late creation, and transport failures. CI runs tests and the demo on Node.js 22 and 24 without secrets.

| Problem | Next step |
| --- | --- |
| Missing credentials | Run `npm run connect` or export both environment variables. |
| No delivery room after connection | Create a private room in PingRoom, then reconnect. |
| `room_not_granted` or a 403 | Check the robot's room access under **Connected Agents** in the app and grant the required room. |
| No answer before the deadline | Confirm the phone received the question, then start a fresh review. |
| `EEXIST` after approval | The sample refuses to overwrite a draft. Choose a new filename or remove the old sample file. |

Exit codes for `npm start`: `0` executed; `2` declined/expired/cancelled; `1` error or local timeout/abort. A handler error propagates to the caller; approval does not guarantee successful execution.

See the other templates: [CI approval with the CLI](https://github.com/pingroom/starter-ci-approval) and [job progress with the SDK](https://github.com/pingroom/starter-job-progress). SDK reference: [pingroom/sdk](https://github.com/pingroom/sdk).

## License

MIT. See [LICENSE](LICENSE).
