import { getModelForClass } from '@typegoose/typegoose'
import DownloadJob from '@/models/DownloadJob'
import DownloadRequest from '@/models/DownloadRequest'

export const DownloadRequestModel = getModelForClass(DownloadRequest)
export const DownloadJobModel = getModelForClass(DownloadJob)
