# Codex Call

Codex Call connects Codex to iMessage through Claw Messenger and to phone calls through SignalWire. It runs as a local macOS service. Install Node.js 22 or later, the Codex CLI, and ngrok, then run `npm ci` and `npm run setup` from this repository to generate your private `.env`.

## First step: SignalWire credentials

1. Open your SignalWire dashboard and select the project containing the number you want to use.
2. Open **API Credentials**. Copy its **Project ID**.
3. Create a new token named **Codex voice bridge**, with the Voice permission needed for Compatibility API calls. Keep the old project's existing tokens intact.
4. On the same page, select **Show** for the **Signing Key** and copy it. Do not reset it.
5. Open the private configuration file in Terminal:

   ```sh
   open -a TextEdit .env
   ```

6. Fill the fields below and save with Command-S:

   ```dotenv
   SIGNALWIRE_SPACE_URL=https://your-space.signalwire.com
   SIGNALWIRE_PHONE_NUMBER=+12025550101
   USER_PHONE_NUMBER=+12025550102
   SIGNALWIRE_PROJECT_ID=your-project-id
   SIGNALWIRE_API_TOKEN=your-new-token
   SIGNALWIRE_SIGNING_KEY=your-existing-signing-key
   ```

Store credentials in the local `.env` file. The [SignalWire credentials guide](https://signalwire.com/docs/platform/your-signalwire-api-space) explains where these fields appear.

## Next: OpenAI and iPhone

1. In the [OpenAI API dashboard](https://platform.openai.com/api-keys), create a project API key and put it on the `OPENAI_API_KEY=` line in the same `.env` file. The API project must have access and available usage for the configured `gpt-realtime` model. See [API key setup](https://developers.openai.com/api/docs/quickstart).
2. Save the Claw Messenger key as `CLAW_API_KEY` in `.env`. Register the receiving iPhone under [Claw Messenger Routes](https://www.clawmessenger.com/routes). The daemon opens the authenticated WebSocket directly. The default `ESCALATION_TIMEOUT_SECONDS` is 60.
3. For Fish Audio, set `FISH_AUDIO_API_KEY` in `.env`. `FISH_AUDIO_VOICE_ID` selects the voice and is prefilled with the requested Snoop Dogg model. Restart the service after changing `.env`. With a Fish Audio key, the bridge sends spoken reply text to Fish Audio and uses its audio in SignalWire calls. Otherwise it uses the existing ElevenLabs or OpenAI voice. [Fish Audio speech API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)

Claw Messenger receives the alert text and its reply. Phone audio is sent to OpenAI for processing. Call and API usage can incur charges.

## Tunnel and activation — finish with Codex

Configure ngrok with your own account, or use an existing Cloudflare tunnel.

After credentials are saved, Codex can start a temporary `ngrok http 3456` tunnel, obtain its HTTPS URL, and set `PUBLIC_WEBHOOK_URL`. Use a stable URL assigned to the ngrok account for the background service. `scripts/start.mjs` then starts both ngrok and the bridge. If the account requires login or another step, Codex will walk you through it.

Before changing the voice routing for the selected number, save its previous voice handler. Set the number's **Voice** handler to a Compatibility/cXML webhook using **POST**, at:

```text
https://YOUR-TUNNEL-HOST/voice/inbound
```

Keep messaging settings and the other phone numbers unchanged. Replacing this voice handler changes where calls to the selected number go.

Once `.env` is complete, build and activate from the repository folder:

```sh
npm run build
npm run setup -- --activate
```

The installer validates configuration, backs up existing files, registers the MCP server, merges lifecycle hooks, adds a short instruction to `~/.codex/AGENTS.md`, and loads the launchd service. Review/trust the new hooks in Codex and restart the app or CLI so it reloads configuration. This trust step is required by [Codex's hook system](https://learn.chatgpt.com/docs/hooks).

## Verification after activation

We will test these together, with the Mac awake and the iPhone nearby:

1. Confirm Claw listener readiness. Send one plain test message and verify the matching reply reaches the listener. Check that the bubble is blue on the iPhone.
2. Trigger a test question. Reply normally in Messages. Verify the answer reaches Codex and no call follows.
3. Trigger a second question and leave it unanswered. Confirm the SignalWire number calls after about 60 seconds.
4. Answer the greeting, reply to the question, and confirm the answer appears in the intended Codex chat.
5. Call the SignalWire number from your configured iPhone, ask for status, then give a harmless test instruction. Confirm the right chat receives it.

Until those steps pass, live audio, actual iPhone delivery, and the account's phone-number capabilities remain unverified.

## How session delivery works

The daemon is the single owner of a private, atomically written state file. Hooks and MCP use an authenticated local HTTP API. A plain reply goes to the latest request that asked for a response. The daemon rejects group messages and echoes, and saves the first matching reply before canceling escalation. The bridge sends other texts and incoming reactions directly to the chat owner, steering an active Codex turn or starting one when idle. If no direct receiver is available, the bridge saves the message for the next lifecycle hook. Reactions never decide an approval. Each event gets at most one call attempt. If a reply races with the call request, the daemon tries to stop the call once SignalWire returns its ID.

For a turn started or steered by an iMessage, the bridge keeps the typing indicator active and sends the final answer when the matching Codex turn stops. A bare yes or no to a question can become a 👍 or 👎, and a short acknowledgment can become a ❤️. Codex can also choose one of these reactions with `thumbs_up_imessage`. Desktop-only turns do not send a mirrored answer.

The desktop app owns its chats independently of the separate managed Codex daemon. The bridge uses the desktop's local IPC for those chats, with lifecycle hooks and MCP polling as a fallback. Routine turn completions do not alert or call. The Stop hook still picks up any already queued instructions. Explicit questions and blockers use the phone MCP tool, which returns the iMessage reply to Codex. The permission hook lets native review continue and asks the bridge to check briefly for an actual desktop approval prompt. Hourly project status iMessages are one-way and never schedule a call. If the desktop app is closed, a chat can pick up saved instructions on its next hook or MCP check.

For chats loaded in the managed app-server daemon, the bridge can submit directly through that daemon's WebSocket control socket. It refuses to silently resume a chat under another owner. An uncertain submission is flagged for review instead of being automatically replayed.

Inbound calls bind to the most recently active, non-ended session registered within the past day. The bridge checks SignalWire's webhook signature and the caller ID. Confirmed desktop approvals get a reminder to review them in Codex. The bridge checks that the request is still waiting before a call. Ordinary texts still go to the chat.

The Mac must remain awake and online. Restarting the bridge preserves event acknowledgments and dial attempts, but active audio calls are not resumed. Calls are limited to five minutes and outbound attempts are spaced at least one minute apart. Event history and delivered instructions are retained for seven days; undelivered instructions are kept for review.

## Maintenance

```sh
# Local verification only: fake telephony providers, no real calls
npm test

# Stop the background service
launchctl bootout "gui/$(id -u)/com.user.codex-voice-bridge"

# Start it again
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.user.codex-voice-bridge.plist"
```

Logs are in the project folder under `logs/`. Keys are kept in the mode-0600 `.env`; state files are mode 0600. Do not share either file. To undo installation, remove the `voice_bridge` MCP entry, this bridge's commands from `hooks.json`, the marked `codex-voice-bridge` block in `AGENTS.md`, and the launchd plist. Backups are created at activation time. Restore the saved SignalWire voice handler if you no longer want the number to answer through the bridge.

## Implementation references

- [SignalWire stream protocol](https://signalwire.com/docs/compatibility-api/cxml/reference/voice/stream)
- [SignalWire webhook signatures](https://signalwire.com/docs/compatibility-api/guides/webhook-security)
- [OpenAI Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claw Messenger API](https://www.clawmessenger.com/docs)
