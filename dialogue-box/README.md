# dialogue-box

Talk with Claude Code and hear the answers. With `/dialogue on`, Claude ends every reply with spoken paragraphs. They
are read aloud one at a time, and a dialogue box above the prompt shows the paragraph you are hearing, like dialogue in
a game. You can rewind, pause, skip or change the speed whenever you like.

## Requirements

- **macOS.** Speech goes through the system `say` and `afplay` commands. On other systems `/dialogue on` explains that it
  cannot run.
- **edge-tts** (optional, `uv tool install edge-tts` or `pipx install edge-tts`; `uvx` alone also works). It gives
  natural Microsoft Edge neural voices for free. The spoken text is sent to Microsoft's speech service; without
  edge-tts, or when that service is unreachable, your Mac's voices read and nothing leaves your machine.
- **ffmpeg** (optional, `brew install ffmpeg`). With it, a paragraph that switches language, like a Polish sentence
  with an English term, plays as one smooth recording. Without it, such a paragraph is read by a single voice.

## Getting started

1. Install it: `/plugin install dialogue-box --marketplace MlecznyU/t-herc-claude-mods`
2. Run `/dialogue setup` to pick your main language, the conversation style, the speech engine and the voices, with a
   sample for each voice. You can skip this: dialogue-box picks good defaults on its own.
3. Run `/dialogue on` and ask something.

## Controls

While a reply is being read, press a digit in the **empty** prompt:

| Key | Action                                                        |
| --- | ------------------------------------------------------------- |
| `1` | back to the previous paragraph (restarts the first one)       |
| `2` | pause / resume (resuming restarts the current paragraph)      |
| `3` | skip to the next paragraph                                    |
| `4` | slower                                                        |
| `5` | faster (the speed is remembered across sessions)              |
| `9` | previous reply, from its start (the last 30 are kept)        |
| `0` | stop and close the box (with replies waiting: the next reply) |

Playback pauses by itself as soon as you start typing or dictating, so the microphone does not pick up the voice.
After the last paragraph the box stays open, so you can still go back, until you send your next message.

A reply you did not ask for (a background task finishing, a scheduled prompt, another session's message) does not cut
in: it waits, the box shows `+1 waiting`, and it plays once the current one ends or you stop it with `0`. Your own
message drops everything playing or waiting. `/dialogue stop` closes the box and clears what waits.

Going back to the previous reply puts the one you were on first in line, so the next reply returns to it. The replies
you heard stay reachable after your own message or a stop: `/dialogue previous` opens the last one. They live in the
session only and are never sent to the model.

Commands: `/dialogue on`, `/dialogue off`, `/dialogue stop`, `/dialogue setup`, and for the current session only
`/dialogue style integrated|mirror` and `/dialogue engine edge|mac` (the defaults are set in `/dialogue setup`).

## Conversation style

- **Integrated** (default): speech carries the conversation. The written reply is a board with what is better seen
  than heard (tables, diagrams, code, paths), and Claude points at it as it talks: "in the engines table, the second
  row…". Nothing is both said and written.
- **Mirror**: the written reply is complete, as without dialogue-box, and the spoken paragraphs sum it up.

## Speech engine

- **Edge** (default): Microsoft Edge neural voices through edge-tts. Words in other languages are read by the same
  voice, the way a person who speaks both would say them. In `/dialogue setup` each voice shows its gender and
  character, with a sample.
- **Mac**: the voices built into macOS, offline.

dialogue-box looks for `edge-tts` on your PATH and in `~/.local/bin`, then for `uvx` (PATH, `~/.local/bin`,
`/opt/homebrew/bin`). With the Edge engine it fetches Edge's voice list at session start, which with `uvx` also
downloads edge-tts the first time.

A Mac voice reads instead when edge-tts is not installed, when Edge has no voice for the language, or when Edge does
not answer (then for the rest of that reply). If you chose Edge yourself, the dialogue box shows why each time and a
notification says it once a session. If you never chose an engine and edge-tts is not installed, Mac voices read
without a warning.

## Mac voices

Claude labels the language of what it says, and of every word in another language, so with Mac voices each part is
read by a voice for that language. For each language dialogue-box uses, in order:

1. the voice you picked in `/dialogue setup`;
2. the best installed voice: Premium, then Enhanced, then standard (novelty voices are never picked);
3. the System Voice, when no voice for that language is installed.

macOS ships only basic voices. For natural speech, download an Enhanced or Premium voice: **System Settings →
Accessibility → Spoken Content → System Voice → Manage Voices…**, then run `/dialogue setup` again. The setup shows which of
your languages are still missing one.

Siri voices cannot be picked by name. To use one, set it as the System Voice in the same settings and choose **System
voice** in `/dialogue setup`.

## License

MIT
