# dialogue-box

Talk with Claude Code and hear the answers. With `/dialogue on`, Claude ends every reply with a few short spoken
paragraphs. Your Mac reads them aloud one at a time, and a dialogue box above the prompt shows the paragraph you are
hearing, like dialogue in a game. You can rewind, pause, skip or change the speed whenever you like.

Everything runs locally with the voices built into macOS. Nothing is sent anywhere.

## Requirements

- **macOS.** Speech goes through the system `say` and `afplay` commands. On other systems `/dialogue on` explains that it
  cannot run.
- **ffmpeg** (optional, `brew install ffmpeg`). With it, a paragraph that switches language, like a Polish sentence
  with an English term, plays as one smooth recording. Without it, such a paragraph is read by a single voice.

## Getting started

1. Install it: `/plugin install dialogue-box --marketplace MlecznyU/t-herc-claude-mods`
2. Run `/dialogue setup` to pick your main language and a voice for it and for English, and to play samples. You can skip
   this: dialogue-box picks the best installed voice for each language on its own.
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
| `0` | stop and close the box                                        |

Playback pauses by itself as soon as you start typing or dictating, so the microphone does not pick up the voice.
After the last paragraph the box stays open, so you can still go back, until you send your next message.

Commands: `/dialogue on`, `/dialogue off`, `/dialogue stop`, `/dialogue setup`.

## Voices

Claude labels the language of what it says, and of every word in another language, so each part is read by a voice
for that language. For each language dialogue-box uses, in order:

1. the voice you picked in `/dialogue setup`;
2. the best installed voice: Premium, then Enhanced, then standard (novelty voices are never picked);
3. the System Voice, when no voice for that language is installed.

macOS ships only basic voices. For natural speech, download an Enhanced or Premium voice: **System Settings →
Accessibility → Spoken Content → System Voice → Manage Voices…**, then run `/dialogue setup` again. The setup shows which of
your languages are still missing one.

Siri voices cannot be picked by name. To use one, set it as the System Voice in the same settings and choose **System
voice** in `/dialogue setup`.

## What Claude says aloud

Spoken paragraphs are short: one point or decision each, the substance first, at most one question at the end. Status
updates stay brief or silent, and lists, tables, code and file paths stay in the written reply. The written reply is
as complete as it would be without dialogue-box.

## License

MIT
