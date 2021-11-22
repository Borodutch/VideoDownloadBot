import Format from '@/models/Format'

export default function constructFormatName(format: Format, mbString: string) {
  return `${format.format.split(' - ')[1]}, ${format.ext}${
    format.filesize
      ? `, ${(format.filesize / 1024 / 1024).toFixed(2)}${mbString}`
      : ''
  }`
}
