import { InputFile } from 'grammy'
import bot from '@/helpers/bot'
import i18n from '@/helpers/i18n'

export default async function sendCompletedFile(
  chatId: number,
  messageId: number,
  language: string,
  audio: boolean,
  title: string,
  file: string | InputFile,
  thumb?: InputFile
) {
  const sendDocumentConfig = {
    caption: i18n.t(language, 'video_caption', {
      bot: bot.botInfo.username,
      title: (title || '').replace('<', '&lt;').replace('>', '&gt;'),
    }),
    parse_mode: 'HTML' as const,
    reply_to_message_id: messageId,
    thumb: audio ? undefined : thumb,
  }
  const sentMessage = audio
    ? await bot.api.sendAudio(chatId, file, sendDocumentConfig)
    : await bot.api.sendVideo(chatId, file, sendDocumentConfig)
  const fileId =
    ('video' in sentMessage && sentMessage.video.file_id) ||
    ('audio' in sentMessage && sentMessage.audio.file_id)
  if (!fileId) {
    throw new Error('File id not found')
  }
  return fileId
}
