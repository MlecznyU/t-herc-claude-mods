import type { Dialog } from '../types'

export function startDialog(id: string, paragraphs: string[], language: string): Dialog {
  return { id, paragraphs, index: 0, language, status: 'playing' }
}

export function previousParagraph(dialog: Dialog): Dialog {
  return { ...dialog, index: Math.max(0, dialog.index - 1), status: 'playing' }
}

export function nextParagraph(dialog: Dialog): Dialog {
  if (dialog.index + 1 >= dialog.paragraphs.length) return { ...dialog, status: 'ended' }

  return { ...dialog, index: dialog.index + 1, status: 'playing' }
}

export function pause(dialog: Dialog): Dialog {
  return dialog.status === 'playing' ? { ...dialog, status: 'paused' } : dialog
}

export function togglePause(dialog: Dialog): Dialog {
  return { ...dialog, status: dialog.status === 'playing' ? 'paused' : 'playing' }
}
