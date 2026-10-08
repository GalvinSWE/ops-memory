# @galvinswe/ops-memory-voice-web

Browser voice client for [ops-memory](https://github.com/GalvinSWE/ops-memory): push to talk, hear
the answer, see the facts it rests on. Speech recognition and speech synthesis run in the browser
(Web Speech API); questions go to an ops-memory voice server (`ops-memory voice`). No runtime
dependencies; React is an optional peer for the hook.

## Install (GitHub Packages)

The package is published to GitHub Packages under the `@galvinswe` scope. Tell npm or yarn where
that scope lives, with a token that has `read:packages`, in the project's `.npmrc`:

```ini
@galvinswe:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```bash
yarn add @galvinswe/ops-memory-voice-web
```

Keep the token in the environment (`GITHUB_PACKAGES_TOKEN`), never in the committed file. CI needs
the same variable.

## React

```tsx
import { useVoiceAsk } from '@galvinswe/ops-memory-voice-web/react';

const voice = useVoiceAsk({ endpoint: 'http://127.0.0.1:7401', language: 'en-US', timeoutMs: 120_000 });

<button onClick={voice.state === 'listening' ? voice.stop : voice.start}>
  {voice.state === 'listening' ? 'Send' : 'Ask'}
</button>
<p>{voice.transcript} {voice.interim}</p>
<p>{voice.result?.answer}</p>
```

`voice` exposes `state` (`idle`, `listening`, `thinking`, `speaking`, `error`), `transcript`,
`interim`, `result` (answer, spoken text, sources), `error`, `supported` (what the browser can do),
and `start`, `stop`, `cancel`, `ask(text)`, `speak(text)`.

## Without React

```ts
import { createVoiceAsk } from '@galvinswe/ops-memory-voice-web';

const voice = createVoiceAsk({ endpoint: 'http://127.0.0.1:7401' });
voice.subscribe(() => render(voice.getSnapshot()));
voice.start();
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | required | Voice server base URL. |
| `language` | `en-US` | BCP 47 language for recognition and speech, e.g. `vi-VN`. |
| `mode` | server default | `auto`, `model` or `facts` (`facts` never calls a model). |
| `unit` | none | Limit answers to one unit (name or id). |
| `speak` | `true` | Read answers out loud. |
| `silenceMs` | `2500` | After speech, send once quiet this long. `0` waits for `stop()`. |
| `timeoutMs` | `60000` | Give up on the server after this long. Local models may need more. |
| `token` | none | Bearer token, if the server requires one. |

## Browser notes

- Speech recognition works in Chrome, Edge and Safari. Chrome sends audio to Google's service for
  recognition; Safari can recognise on the device.
- The page must be served from `localhost` or HTTPS for microphone access.
- Nothing touches `window` until `start`, `ask` or `speak` runs, so it is safe in server rendering.
