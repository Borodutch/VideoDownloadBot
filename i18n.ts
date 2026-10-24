const strings = {
  en: {
    help: "😎 Send me a link to a video, and I'll send the video back.\n\nWorks in groups too: add me to a group, and I'll download every video link posted there.",
    downloading: '⏬ Downloading…',
    uploading: '⏫ Uploading…',
    failed: "😱 I couldn't download this video.",
    tooBig: '😱 This video is too large for Telegram.',
  },
  ru: {
    help: '😎 Пришлите мне ссылку на видео, и я пришлю само видео.\n\nВ группах тоже работаю: добавьте меня в группу, и я буду скачивать все видео по ссылкам, которые там отправляют.',
    downloading: '⏬ Скачиваю…',
    uploading: '⏫ Загружаю…',
    failed: '😱 Не получилось скачать это видео.',
    tooBig: '😱 Это видео слишком большое для Telegram.',
  },
  es: {
    help: '😎 Envíame un enlace a un vídeo y te enviaré el vídeo.\n\nTambién funciono en grupos: añádeme a un grupo y descargaré todos los vídeos cuyos enlaces se publiquen allí.',
    downloading: '⏬ Descargando…',
    uploading: '⏫ Subiendo…',
    failed: '😱 No pude descargar este vídeo.',
    tooBig: '😱 Este vídeo es demasiado grande para Telegram.',
  },
  'pt-br': {
    help: '😎 Me mande o link de um vídeo e eu te envio o vídeo.\n\nTambém funciono em grupos: me adicione a um grupo e vou baixar todos os vídeos cujos links forem enviados lá.',
    downloading: '⏬ Baixando…',
    uploading: '⏫ Enviando…',
    failed: '😱 Não consegui baixar este vídeo.',
    tooBig: '😱 Este vídeo é grande demais para o Telegram.',
  },
  pt: {
    help: '😎 Envia-me a ligação de um vídeo e eu envio-te o vídeo.\n\nTambém funciono em grupos: adiciona-me a um grupo e vou descarregar todos os vídeos cujas ligações forem partilhadas lá.',
    downloading: '⏬ A descarregar…',
    uploading: '⏫ A enviar…',
    failed: '😱 Não consegui descarregar este vídeo.',
    tooBig: '😱 Este vídeo é demasiado grande para o Telegram.',
  },
  ja: {
    help: '😎 動画のリンクを送ってください。動画にしてお返しします。\n\nグループでも使えます：私をグループに追加すると、投稿された動画リンクをすべてダウンロードします。',
    downloading: '⏬ ダウンロード中…',
    uploading: '⏫ アップロード中…',
    failed: '😱 この動画をダウンロードできませんでした。',
    tooBig: '😱 この動画はTelegramに送るには大きすぎます。',
  },
  zh: {
    help: '😎 给我发送视频链接，我会把视频发回给你。\n\n也可以在群组中使用：把我加入群组，我会下载群里发的所有视频链接。',
    downloading: '⏬ 正在下载…',
    uploading: '⏫ 正在上传…',
    failed: '😱 无法下载这个视频。',
    tooBig: '😱 这个视频太大，无法发送到 Telegram。',
  },
  ar: {
    help: '😎 أرسل لي رابط فيديو وسأرسل لك الفيديو نفسه.\n\nأعمل في المجموعات أيضًا: أضفني إلى مجموعة وسأنزّل كل فيديو يُنشر رابطه هناك.',
    downloading: '⏬ جارٍ التنزيل…',
    uploading: '⏫ جارٍ الرفع…',
    failed: '😱 لم أتمكن من تنزيل هذا الفيديو.',
    tooBig: '😱 هذا الفيديو كبير جدًا بالنسبة لتيليجرام.',
  },
  fa: {
    help: '😎 لینک یک ویدیو را برایم بفرست تا خود ویدیو را برایت بفرستم.\n\nدر گروه‌ها هم کار می‌کنم: من را به گروه اضافه کن تا همه ویدیوهایی را که لینکشان آنجا فرستاده می‌شود دانلود کنم.',
    downloading: '⏬ در حال دانلود…',
    uploading: '⏫ در حال آپلود…',
    failed: '😱 نتوانستم این ویدیو را دانلود کنم.',
    tooBig: '😱 این ویدیو برای تلگرام خیلی بزرگ است.',
  },
}

export type Key = keyof typeof strings.en

// Telegram sends IETF codes like "en", "pt-br", "zh-hans"; plain "pt" means Portugal
export function lang(code = 'en'): keyof typeof strings {
  code = code.toLowerCase()
  if (code in strings) return code as keyof typeof strings
  const base = code.split('-')[0]
  return base in strings ? (base as keyof typeof strings) : 'en'
}

export const t = (code: string | undefined, key: Key) => strings[lang(code)][key]
