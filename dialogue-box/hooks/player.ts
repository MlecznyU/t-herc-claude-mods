export type PlaybackCommand = { argv: string[]; input?: string }

export type VoicedText = { voice: string | undefined; text: string }

export const LIST_VOICES = ['say', '-v', '?']
export const READ_SYSTEM_LOCALE = ['defaults', 'read', '-g', 'AppleLocale']
export const CREATE_RENDER_DIRECTORY = ['/bin/sh', '-c', 'mktemp -d "${TMPDIR:-/tmp}/dialogue-box.XXXXXX"']

// Each `say` start costs up to a second, so a paragraph that switches voices is rendered in parallel and joined into
// one file ahead of time; playing it is then a single afplay with no seams between the voices.
const RENDER_SCRIPT = `
out=$1
rate=$2
shift 2
parts="$out.parts"
mkdir "$parts" || exit 1
count=0
while [ $# -gt 1 ]; do
  if [ -n "$1" ]; then say -v "$1" -r "$rate" -o "$parts/$count.aiff" "$2" & else say -r "$rate" -o "$parts/$count.aiff" "$2" & fi
  count=$((count + 1))
  shift 2
done
wait
ffmpeg=$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)
inputs=
graph=
labels=
index=0
while [ $index -lt $count ]; do
  inputs="$inputs -i $parts/$index.aiff"
  graph="$graph[$index:a]aresample=24000[a$index];"
  labels="$labels[a$index]"
  index=$((index + 1))
done
"$ffmpeg" -loglevel error -y $inputs -filter_complex "\${graph}\${labels}concat=n=$count:v=0:a=1" "$out"
status=$?
rm -rf "$parts"
exit $status
`

function sayArgv(voice: string | undefined, wordsPerMinute?: number): string[] {
  const rate = wordsPerMinute === undefined ? [] : ['-r', String(wordsPerMinute)]

  return voice === undefined ? ['say', ...rate] : ['say', '-v', voice, ...rate]
}

export function liveCommand({ voice, text }: VoicedText, wordsPerMinute: number): PlaybackCommand {
  return { argv: sayArgv(voice, wordsPerMinute), input: text }
}

export function sampleCommand({ voice, text }: VoicedText): PlaybackCommand {
  return { argv: sayArgv(voice), input: text }
}

export function renderArgv(out: string, parts: VoicedText[], wordsPerMinute: number): string[] {
  const pairs = parts.flatMap(part => [part.voice ?? '', part.text])

  return ['/bin/sh', '-c', RENDER_SCRIPT, 'dialogue-box', out, String(wordsPerMinute), ...pairs]
}
