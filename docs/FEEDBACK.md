# App feedback through Formspree

The Feedback button opens a message dialog without leaving the current screen.
It is also available during loading, setup, and runtime errors after the interface loads.
Feedback requires an internet connection. It does not support replies.

## Message and privacy

The app sends these five fields when you press Send:

| Field | Content |
|---|---|
| `message` | The text you enter, up to 4,000 Unicode characters |
| `screen` | A fixed screen category, such as `project` or `skill` |
| `tab` | A fixed primary tab or editor mode, or `none` or `unknown` |
| `appVersion` | The application version |
| `os` | `macos`, `windows`, `linux`, or `unknown` |

Included context shows the four automatic fields before submission.
The app captures context when a new draft opens. Navigation does not change that draft's context.
Clear starts a new draft with the current context.
Nested filters and selected records are not context fields.

The app does not attach names, email addresses, project identifiers, paths, document contents, logs, or usage records automatically.
Your message can contain personal information if you enter it. Include only what you want to share.

The dialog says, "No personal data attached automatically."
This describes the application's payload. Formspree also processes network metadata.
The request omits browser credentials and the referrer. It does not hide your network address from the provider.
Formspree can add submission dates and delivery status in its dashboard.

## Drafts and delivery

Drafts stay in memory during the app session. Closing the dialog or navigating away keeps the draft.
Restarting the app loses it. The app does not write feedback drafts to disk.

While sending, the message and Clear control are disabled. You can still close and reopen the dialog.
A verified acceptance clears the draft and shows "Feedback sent. Thank you."
This confirms provider acceptance. It does not prove arrival in the recipient's email inbox.

A rejected or uncertain request keeps the draft. Requests time out after 15 seconds.
The app never retries automatically. Retry after uncertain delivery can create a duplicate.
A provider retry deadline remains active after editing or clearing the draft.

## Integration and tests

The desktop frontend sends JSON directly to Formspree with `fetch`.
There is no feedback proxy, Python command, or native HTTP plugin.
The adapter rebuilds the payload from the five permitted fields and rejects redirects.
It accepts only a successful JSON response with `ok: true` and `next: "/thanks"`.
HTML challenges, malformed responses, and network failures do not clear the draft.

The submission endpoint is defined in [feedbackClient.ts](../app/src/lib/feedbackClient.ts).
It is a public form address, not an API secret. It ships in production source and application assets.
Do not put dashboard credentials or management tokens in the frontend.
Fork maintainers must replace the endpoint before distributing their own build.

`VISUAL_MOCK=1` builds and unit tests substitute a fake transport.
Preview, screenshot, and browser tests must never submit to the live form.
Preview flags select simulated results: `feedback=uncertain`, `feedback=blocked`, `feedback=limited`, or `feedback=sending`.
For example, open `/?feedback=uncertain#/`, then open Feedback and send a synthetic draft.

A live compatibility check needs explicit authorization for its endpoint and send count.
Use synthetic text and an isolated native view. Record the OS, webview origin, HTTP response, dashboard receipt, and email receipt separately.
A successful browser preview does not establish native compatibility.
Before release, verify each target platform and the actual packaged application.
