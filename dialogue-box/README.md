# dialogue-box

Talk with Claude Code and hear the answers. With `/dialogue on`, Claude ends every reply with spoken paragraphs. They
are read aloud one at a time, and a dialogue box above the prompt shows the paragraph you are hearing, like dialogue in
a game. You can rewind, pause, skip or change the speed whenever you like.

## Requirements

- **macOS.** Speech goes through the system `say` and `afplay` commands. On other systems `/dialogue on` explains that it
  cannot run.
- **voxlektor** (optional, Apple Silicon with macOS 14+): a local neural voice that runs on your Mac, nothing leaves
  it. `/dialogue setup` installs and sets it up step by step (see [voxlektor](#voxlektor)).
- **edge-tts** (optional, `uv tool install edge-tts` or `pipx install edge-tts`; `uvx` alone also works). It gives
  natural Microsoft Edge neural voices for free. The spoken text is sent to Microsoft's speech service; without
  edge-tts, or when that service is unreachable, your Mac's voices read and nothing leaves your machine.
- **ffmpeg** (optional, `brew install ffmpeg`). With it, a paragraph that switches language, like a Polish sentence
  with an English term, plays as one smooth recording. Without it, such a paragraph is read by a single voice.

## Getting started

1. Install it: `/plugin install dialogue-box --marketplace MlecznyU/t-herc-claude-mods`
2. Run `/dialogue setup` to pick your main language, the conversation style, the speech engine and the voices, with a
   sample for each voice. You can skip this: dialogue-box picks good defaults on its own.
3. Run `/dialogue on` and ask something. To have it on in every new session, pick **Dialogue on in every new
   session** under *Start of a session* in `/dialogue setup`.

## Controls

While a reply is being read, press a digit in the **empty** prompt:

| Key | Action                                                        |
| --- | ------------------------------------------------------------- |
| `1` | back to the previous paragraph (restarts the first one; voxlektor 0.4.0: see below) |
| `2` | pause / resume (Edge and Mac voices restart the current paragraph; voxlektor goes on where it paused) |
| `3` | skip to the next paragraph                                    |
| `4` | slower                                                        |
| `5` | faster (the speed is remembered across sessions)              |
| `6` | stop and close the box (with replies waiting: the next reply) |
| `8` | play now (voxlektor, while another session is speaking)       |
| `9` | previous reply, from its start (the last 30 are kept)        |

Playback pauses by itself as soon as you start typing or dictating, so the microphone does not pick up the voice.
After the last paragraph the box stays open, so you can still go back, until you send your next message.

With voxlektor 0.4.0 or newer, skip and back keep the audio voxlektor has already prepared, so the next paragraph
starts at once. Back works like a music player's: partway through a paragraph it restarts that paragraph, at its start
it goes to the paragraph you heard before it (on the first paragraph it always restarts it). The box moves on every
press and shows ⏳ until voxlektor starts that paragraph; if voxlektor restarted the paragraph instead, the box goes
back to it. Presses add up from what the box shows: three skips move three paragraphs, and a skip right after a back
reads again from the paragraph you left. Back never leaves the reply: once the paragraphs you heard to the end are
used up (for example after skipping), it reads again from the paragraph before, which takes a moment. While paused,
or with an older voxlektor, both keys read again from the target paragraph too.

A reply you did not ask for (a background task finishing, a scheduled prompt, another session's message) does not cut
in: it waits, the box shows `+1 waiting`, and it plays once the current one ends or you stop it with `6`. Your own
message drops everything playing or waiting. `/dialogue stop` closes the box and clears what waits.

Going back to the previous reply puts the one you were on first in line, so the next reply returns to it. The replies
you heard stay reachable after your own message or a stop: `/dialogue previous` opens the last one. They live in the
session only and are never sent to the model.

Commands: `/dialogue on`, `/dialogue off`, `/dialogue stop`, `/dialogue setup`, and for the current session only
`/dialogue style integrated|mirror` and `/dialogue engine edge|mac|voxlektor` (the defaults are set in
`/dialogue setup`).

## Conversation style

- **Integrated** (default): speech carries the conversation. The written reply is a board with what is better seen
  than heard (tables, diagrams, code, paths), and Claude points at it as it talks: "in the engines table, the second
  row…". Nothing is both said and written.
- **Mirror**: the written reply is complete, as without dialogue-box, and the spoken paragraphs sum it up.

## Speech engine

- **voxlektor**: a local neural voice on Apple Silicon. A reply is handed over whole, so its paragraphs, and the
  replies queued behind it, follow each other without a gap. Offline; it is the default once it is set up.
- **Edge**: Microsoft Edge neural voices through edge-tts, the default where voxlektor is not set up. Words in other
  languages are read by the same voice, the way a person who speaks both would say them. In `/dialogue setup` each
  voice shows its gender and character, with a sample.
- **Mac**: the voices built into macOS, offline.

The engine you pick in `/dialogue setup` is kept. Without a pick, dialogue-box takes voxlektor when it is ready, else
Edge when edge-tts is found, else the Mac voices.

dialogue-box looks for `edge-tts` on your PATH and in `~/.local/bin`, then for `uvx` (PATH, `~/.local/bin`,
`/opt/homebrew/bin`). With the Edge engine it fetches Edge's voice list at session start, which with `uvx` also
downloads edge-tts the first time.

A Mac voice reads instead when edge-tts is not installed, when Edge has no voice for the language, or when Edge does
not answer (then for the rest of that reply). If you chose Edge yourself, the dialogue box shows why each time and a
notification says it once a session. If you never chose an engine and edge-tts is not installed, Mac voices read
without a warning.

## voxlektor

[voxlektor](https://github.com/MlecznyU/voxlektor) reads with a neural voice model on your own Mac (Apple Silicon,
macOS 14 or newer). The voxlektor section of `/dialogue setup` shows the next step and runs it only when you press its
button; **No, show me the command** shows the command to run in a terminal instead:

1. **Install uv**, the tool voxlektor installs with, when it is missing.
2. **Install voxlektor** (or **Update voxlektor** when the installed one lacks something dialogue-box needs; the
   section names what): the pinned release v0.4.0 through `uv tool install`. dialogue-box speaks to every voxlektor
   from 0.2.0 up to, not including, 1.0.0. A voxlektor past v0.4.0 is never reinstalled, as that would be a
   downgrade: one at or past 1.0.0 means dialogue-box needs an update, and one in between that lacks something is
   yours to repair (`vxl setup --check` shows what it reports). Edge or a Mac voice reads until then.
3. **Accept & download**: the voice model, about 1.7 GB, under the license the section shows (non-commercial use only).
   From voxlektor 0.3.0 on the same run creates the `claude` profile dialogue-box reads with; when only the profile is
   missing, **Create the claude profile** runs `vxl setup --yes --profile claude`. With 0.2.x, when the model is
   there but `vxl setup` never finished, **Finish voxlektor setup** runs `vxl setup --yes`.
4. Once ready, the section shows the voice, rate, volume and quality steps, with ▶ for a sample.

To tune the voice, run `vxl setup --profile claude` in a terminal (`vxl setup` with voxlektor 0.2.x; the setup section
shows the exact command). It changes only how dialogue-box reads, not your own `vxl`. The speed keys `4` and `5`
multiply the rate you set there.

**Several sessions take turns.** Each Claude Code session reads under its own name, and voxlektor reads one at a time:
none interrupts another. A reply that comes while another session speaks waits, and the box shows
`🕒 waiting · another session is speaking (n ahead)`. It starts when the other reply ends. Your keys act on your
session only: typing in one session does not pause another. **play now** (`8`) jumps the queue: it interrupts the
session speaking, which goes on after your reply.

While the model loads, the box shows `🔥 warming up voice…`; `/dialogue on` starts loading it while Claude writes the
first reply. A pause from outside the session (a media key, `vxl pause`) shows as held, and the box offers resume; it
lifts the hold when your session is the one speaking. Switching the engine while a reply is read hands the paragraph on
screen to the new engine.

If voxlektor fails during a reply (an error, the daemon stopping, a command that fails or gets no answer within
20 s), Edge reads the rest of that reply, or a Mac voice where Edge cannot; the box shows why and a notification says
it once. The next reply tries voxlektor again. A reply waiting for its turn is never a failure.

The keys never wait for voxlektor: stop, pause and resume go out at once, even while a paragraph is still being handed
over, and stop cuts that hand-over short. A voxlektor daemon that hangs (it holds its lock but does not answer) is
named, not just fallen back from: the box, a notification and the setup section say
`voxlektor is not answering (pid N): run vxl stop`. Run that in a terminal, and the next reply reads with voxlektor
again.

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
