import { InputFile } from 'grammy'
import { Message } from '@grammyjs/types'
import bot from '@/helpers/bot'
import i18n from '@/helpers/i18n'
import videoUploadBot from '@/helpers/videoUploadBot'

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
  let sentMessage:
    | Message.DocumentMessage
    | Message.AudioMessage
    | Message.VideoMessage
  const botToSendMessage = file instanceof InputFile ? videoUploadBot : bot
  try {
    sentMessage = audio
      ? await botToSendMessage.api.sendAudio(chatId, file, sendDocumentConfig)
      : await botToSendMessage.api.sendVideo(chatId, file, sendDocumentConfig)
  } catch (error) {
    sentMessage = await botToSendMessage.api.sendDocument(
      chatId,
      file,
      sendDocumentConfig
    )
  }
  const fileId =
    ('video' in sentMessage && sentMessage.video.file_id) ||
    ('audio' in sentMessage && sentMessage.audio.file_id) ||
    ('document' in sentMessage && sentMessage.document.file_id)
  if (!fileId) {
    throw new Error('File id not found')
  }
  return fileId
}
