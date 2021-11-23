export default function augmentError(error: unknown, augmentation: string) {
  if (error instanceof Error) {
    error.message = `${error.message}, ${augmentation}`
  } else {
    error = `${error}, ${augmentation}`
  }
  return error
}
