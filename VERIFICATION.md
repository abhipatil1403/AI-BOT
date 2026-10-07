# Verification

Verified on Windows on 8 October 2026:

- Lint and strict TypeScript checking pass.
- 91 unit, provider, integration, keyboard and widget tests pass, including cookie formats, current Groq model validation, safe HTTP errors, controlled JSON-generation retries, actual HTTP responses with large cookie headers and capture-protection configuration migration/browser redaction.
- Both Electron and Chromium production builds succeed.
- NSIS installer and portable EXE packaging succeeds without native compilation.
- The packaged application (`release/win-unpacked/AI Quick Answer.exe`) launches with its actual ASAR bundle and N-API keyboard binary.
- The packaged end-to-end smoke test passes: actual OS Ctrl+V pastes normally and triggers one clipboard request; descriptive hover, timed MCQ display, raw code copying, OS credential encryption, Gemini switching, MV3 pairing, extension rendering and user-controlled sharing visibility work.
- Dependency audit reports zero vulnerabilities.

The smoke runner installs synthetic HTTP fixtures into the test process externally. Production provider code, credential storage, windows, OS clipboard/hotkey, and extension communication are real. No mock responses or mock provider branches exist in production bundles. Native Windows input was additionally verified using the computer-use tools against the test window.

Version 1.0.1 was also checked against **live Groq** using the user's locally saved encrypted credential: the legacy model returned HTTP 404; authentication/model validation and descriptive, MCQ and Python code answers succeeded with `openai/gpt-oss-120b`. These checks used synthetic questions and never logged or committed the credential, provider error bodies or private clipboard contents.

Version 1.0.2 was checked against **live Gemini** using the explicitly supplied cookie export held only in memory. The old transport failed with UND_ERR_HEADERS_OVERFLOW; the bounded 64 KiB Gemini dispatcher successfully validated the session and returned descriptive, MCQ and Python code answers through the actual answer pipeline. No cookie values, session tokens or response bodies were logged or committed.

The packaged 1.0.2 Settings screen also successfully validated both the supplied JSON export and its equivalent Cookie header against live Gemini, using an isolated profile without saving the credential. The packaged Ctrl+V and Chromium extension smoke test passed again after this fix.

Version 1.0.3 passed the packaged smoke suite with the new Windows capture exclusion enabled. A separate process queried the actual native HWNDs using GetWindowDisplayAffinity: both Settings and widget returned 0x11 (WDA_EXCLUDEFROMCAPTURE), both returned 0x00 when disabled, and both returned 0x11 after re-enabling. During sharing mode the protected desktop remained visible and the Chromium overlay was hidden. The existing hide-both mode, actual OS Ctrl+V, all answer modes, exact code copying and MV3 pairing also passed. The extension archive contains manifest version 1.0.1.

These checks verify the native Windows affinity and application behavior, not every meeting or recording application's capture path. Zoom, Meet, Teams and OBS receiver previews were not individually tested. Check the actual sharing preview before relying on exclusion; Microsoft does not guarantee it against all capture methods.

Gemini Web is an unofficial session protocol and can change independently of this application. Windows build artifacts are unsigned; supply your own signing certificate for a signed distribution.

Reproduce:

```sh
npm install
npm run check
npx playwright install chromium
npm run test:e2e
npm run package
```

For packaged smoke verification in PowerShell:

```powershell
$env:AI_BOT_SMOKE_EXE = Join-Path (Get-Location) 'release\win-unpacked\AI Quick Answer.exe'
npm run test:e2e
Remove-Item Env:AI_BOT_SMOKE_EXE
```

Quit any existing companion first so port 47831 is free. Use an interactive Windows desktop without concurrent typing during native input tests. `AI_BOT_SMOKE_NATIVE=manual` pauses at the paste target for a real Ctrl+V chord instead of the test runner's native input driver. Test profiles are temporary; clipboard text is restored when it still contains test text. Screenshots stay in ignored `test-results/` and are not committed.
