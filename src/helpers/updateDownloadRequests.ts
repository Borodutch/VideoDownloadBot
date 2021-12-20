import { Chat, findOrCreateChat } from '@/models/Chat'
import { DocumentType } from '@typegoose/typegoose'
import { findDownloadRequestsForDownloadJob } from '@/models/downloadRequestFunctions'
import { findUrl } from '@/models/Url'
import DownloadJob from '@/models/DownloadJob'
import DownloadJobStatus from '@/models/DownloadJobStatus'
import DownloadRequest from '@/models/DownloadRequest'
import MessageEditor from '@/helpers/MessageEditor'
import downloadUrl from '@/helpers/downloadUrl'
import i18n from '@/helpers/i18n'
import report from '@/helpers/report'
import sendCompletedFile from '@/helpers/sendCompletedFile'

type ChatMap = { [chatId: number]: Chat }

async function getDownloadRequestsChatsAndEditors(
  downloadJob: DocumentType<DownloadJob>
) {
  const requests = await findDownloadRequestsForDownloadJob(downloadJob)
  const chats: ChatMap = {}
  for (const request of requests) {
    if (!chats[request.chatId]) {
      const { doc: chat } = await findOrCreateChat(request.chatId)
      chats[request.chatId] = chat
    }
  }
  const editors = requests.map(
    (request) => new MessageEditor(request.messageId, undefined, request.chatId)
  )
  return { requests, chats, editors }
}

async function updateMessages(
  editors: MessageEditor[],
  chats: ChatMap,
  localizationKey: string
) {
  for (const editor of editors) {
    const chat = editor.chatId && chats[editor.chatId]
    if (chat) {
      await editor.editMessage(i18n.t(chat.language, localizationKey))
    }
  }
}

async function sendFileToNonOriginalRequests(
  downloadJob: DocumentType<DownloadJob>,
  requests: DocumentType<DownloadRequest>[],
  chats: ChatMap
) {
  const otherRequests = requests.filter(
    (request) =>
      request.chatId !== downloadJob.originalChatId &&
      request.messageId !== downloadJob.originalMessageId
  )
  if (!otherRequests.length) {
    return
  }
  const cachedUrl = await findUrl(downloadJob.url, downloadJob.audio)
  if (!cachedUrl) {
    throw new Error('Cached url not found')
  }
  for (const request of otherRequests) {
    const chat = chats[request.chatId]
    try {
      await sendCompletedFile(
        request.chatId,
        request.messageId,
        chat.language,
        downloadJob.audio,
        cachedUrl.title,
        cachedUrl.fileId
      )
    } catch (error) {
      report(error, { location: 'sendFileToNonOriginalRequests' })
    }
  }
}

async function deleteDocuments(
  downloadJob: DocumentType<DownloadJob>,
  requests: DocumentType<DownloadRequest>[]
) {
  for (const request of requests) {
    try {
      await request.delete()
    } catch (error) {
      report(error, { location: 'deleteDocuments.request' })
    }
  }
  try {
    await downloadJob.delete()
  } catch (error) {
    report(error, { location: 'deleteDocuments.job' })
  }
}

export default async function updateDownloadRequests(
  downloadJob: DocumentType<DownloadJob>
) {
  if (downloadJob.status === DownloadJobStatus.created) {
    return
  }
  const { requests, chats, editors } = await getDownloadRequestsChatsAndEditors(
    downloadJob
  )
  switch (downloadJob.status) {
    case DownloadJobStatus.downloading:
      await downloadUrl(downloadJob)
      break
    case DownloadJobStatus.uploading:
      await updateMessages(editors, chats, 'uploading_started')
      break
    case DownloadJobStatus.finished:
      await updateMessages(editors, chats, 'download_complete')
      await sendFileToNonOriginalRequests(downloadJob, requests, chats)
      await deleteDocuments(downloadJob, requests)
      break
    case DownloadJobStatus.failedDownload:
      await updateMessages(editors, chats, 'error_video_download')
      await deleteDocuments(downloadJob, requests)
      break
    case DownloadJobStatus.failedUpload:
      await updateMessages(editors, chats, 'error_video_upload')
      await deleteDocuments(downloadJob, requests)
      break
    case DownloadJobStatus.unsupportedUrl:
      await updateMessages(editors, chats, 'error_unsupported_url')
      await deleteDocuments(downloadJob, requests)
      break
  }
}
