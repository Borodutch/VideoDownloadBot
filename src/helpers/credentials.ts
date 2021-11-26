const linksToCredentialNames = [
  {
    links: ['instagram'],
    key: 'instagram',
  },
]

export default async function credentials(url: string) {
  const credentials = ((await import('../credentials.json')) || {}) as Record<
    string,
    Record<string, string>
  >
  console.log('credentials', credentials, url)
  if (!credentials || !Object.keys(credentials).length) {
    return {}
  }
  for (const { links, key } of linksToCredentialNames) {
    for (const link of links) {
      if (url.includes(link)) {
        return credentials[key]
      }
    }
  }
  return {}
}
