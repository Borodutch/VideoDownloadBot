import { unlinkSync } from 'fs'

export default function unlincSyncSafe(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    console.error(`Error unlinking ${path}: ${error}`)
  }
}
