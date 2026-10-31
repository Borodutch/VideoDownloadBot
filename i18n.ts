const strings = {
  en: {
    help: "😎 Send me a link to a video, and I'll send the video back.\n\nWorks in groups too: add me to a group, and I'll download every video link posted there.",
    downloading: '⏬ Downloading…',
    queued: "⏳ In the queue: I'm busy with other videos and will start on this one as soon as I can…",
    restarting: "🔄 I'm restarting for an update, so this download was cancelled. Please send the link again in a minute.",
    uploading: '⏫ Uploading…',
    failed: "😱 I couldn't download this video.",
    tooBig: '😱 This video is too large for Telegram.',
    live: "📡 This is a live stream, so I can't download it yet. Try sending me the recording once the stream has ended.",
    upcoming: "⏳ This stream hasn't started yet, so there's nothing to download. Try sending me the recording once it has ended.",
  },
  ru: {
    help: '😎 Пришлите мне ссылку на видео, и я пришлю само видео.\n\nВ группах тоже работаю: добавьте меня в группу, и я буду скачивать все видео по ссылкам, которые там отправляют.',
    downloading: '⏬ Скачиваю…',
    queued: '⏳ В очереди: сейчас я скачиваю другие видео, а за ваше возьмусь, как только смогу…',
    restarting: '🔄 Я перезапускаюсь для обновления, поэтому эта загрузка отменена. Пришлите ссылку ещё раз через минуту.',
    uploading: '⏫ Загружаю…',
    failed: '😱 Не получилось скачать это видео.',
    tooBig: '😱 Это видео слишком большое для Telegram.',
    live: '📡 Это прямая трансляция, поэтому пока я не могу её скачать. Пришлите мне запись, когда трансляция закончится.',
    upcoming: '⏳ Эта трансляция ещё не началась, поэтому скачивать пока нечего. Пришлите мне запись, когда она закончится.',
  },
  es: {
    help: '😎 Envíame un enlace a un vídeo y te enviaré el vídeo.\n\nTambién funciono en grupos: añádeme a un grupo y descargaré todos los vídeos cuyos enlaces se publiquen allí.',
    downloading: '⏬ Descargando…',
    queued: '⏳ En cola: ahora estoy descargando otros vídeos y empezaré con este en cuanto pueda…',
    restarting: '🔄 Me estoy reiniciando para actualizarme, así que he cancelado esta descarga. Vuelve a enviarme el enlace dentro de un minuto.',
    uploading: '⏫ Subiendo…',
    failed: '😱 No pude descargar este vídeo.',
    tooBig: '😱 Este vídeo es demasiado grande para Telegram.',
    live: '📡 Es una transmisión en directo, así que todavía no puedo descargarla. Envíame la grabación cuando haya terminado.',
    upcoming: '⏳ Esta transmisión aún no ha empezado, así que no hay nada que descargar. Envíame la grabación cuando haya terminado.',
  },
  'pt-br': {
    help: '😎 Me mande o link de um vídeo e eu te envio o vídeo.\n\nTambém funciono em grupos: me adicione a um grupo e vou baixar todos os vídeos cujos links forem enviados lá.',
    downloading: '⏬ Baixando…',
    queued: '⏳ Na fila: estou baixando outros vídeos agora e começo este assim que puder…',
    restarting: '🔄 Estou reiniciando para uma atualização, então este download foi cancelado. Me mande o link de novo daqui a um minuto.',
    uploading: '⏫ Enviando…',
    failed: '😱 Não consegui baixar este vídeo.',
    tooBig: '😱 Este vídeo é grande demais para o Telegram.',
    live: '📡 Esta é uma transmissão ao vivo, então ainda não consigo baixá-la. Me mande a gravação quando ela terminar.',
    upcoming: '⏳ Esta transmissão ainda não começou, então não há nada para baixar. Me mande a gravação quando ela terminar.',
  },
  pt: {
    help: '😎 Envia-me a ligação de um vídeo e eu envio-te o vídeo.\n\nTambém funciono em grupos: adiciona-me a um grupo e vou descarregar todos os vídeos cujas ligações forem partilhadas lá.',
    downloading: '⏬ A descarregar…',
    queued: '⏳ Na fila: estou a descarregar outros vídeos e começo este assim que puder…',
    restarting: '🔄 Estou a reiniciar para uma atualização, por isso esta transferência foi cancelada. Envia-me a ligação outra vez daqui a um minuto.',
    uploading: '⏫ A enviar…',
    failed: '😱 Não consegui descarregar este vídeo.',
    tooBig: '😱 Este vídeo é demasiado grande para o Telegram.',
    live: '📡 Isto é uma transmissão em direto, por isso ainda não a consigo descarregar. Envia-me a gravação quando tiver terminado.',
    upcoming: '⏳ Esta transmissão ainda não começou, por isso não há nada para descarregar. Envia-me a gravação quando tiver terminado.',
  },
  ja: {
    help: '😎 動画のリンクを送ってください。動画にしてお返しします。\n\nグループでも使えます：私をグループに追加すると、投稿された動画リンクをすべてダウンロードします。',
    downloading: '⏬ ダウンロード中…',
    queued: '⏳ 順番待ち中です。ほかの動画をダウンロードしているので、できるだけ早くこの動画に取りかかります…',
    restarting: '🔄 アップデートのために再起動しているので、このダウンロードはキャンセルされました。1分ほどしてから、もう一度リンクを送ってください。',
    uploading: '⏫ アップロード中…',
    failed: '😱 この動画をダウンロードできませんでした。',
    tooBig: '😱 この動画はTelegramに送るには大きすぎます。',
    live: '📡 これはライブ配信なので、まだダウンロードできません。配信が終わったら、アーカイブを送ってください。',
    upcoming: '⏳ この配信はまだ始まっていないので、ダウンロードできるものがありません。配信が終わったら、アーカイブを送ってください。',
  },
  zh: {
    help: '😎 给我发送视频链接，我会把视频发回给你。\n\n也可以在群组中使用：把我加入群组，我会下载群里发的所有视频链接。',
    downloading: '⏬ 正在下载…',
    queued: '⏳ 排队中：我正在下载其他视频，会尽快开始处理这个视频…',
    restarting: '🔄 我正在重启以进行更新，所以这次下载已取消。请过一分钟再把链接发给我。',
    uploading: '⏫ 正在上传…',
    failed: '😱 无法下载这个视频。',
    tooBig: '😱 这个视频太大，无法发送到 Telegram。',
    live: '📡 这是正在进行的直播，所以暂时无法下载。直播结束后，请把回放发给我。',
    upcoming: '⏳ 这个直播还没有开始，所以没有可下载的内容。直播结束后，请把回放发给我。',
  },
  ar: {
    help: '😎 أرسل لي رابط فيديو وسأرسل لك الفيديو نفسه.\n\nأعمل في المجموعات أيضًا: أضفني إلى مجموعة وسأنزّل كل فيديو يُنشر رابطه هناك.',
    downloading: '⏬ جارٍ التنزيل…',
    queued: '⏳ في قائمة الانتظار: أنزّل فيديوهات أخرى الآن، وسأبدأ بهذا الفيديو في أقرب وقت ممكن…',
    restarting: '🔄 أُعيد التشغيل الآن من أجل تحديث، لذا أُلغي هذا التنزيل. أرسل لي الرابط مرة أخرى بعد دقيقة.',
    uploading: '⏫ جارٍ الرفع…',
    failed: '😱 لم أتمكن من تنزيل هذا الفيديو.',
    tooBig: '😱 هذا الفيديو كبير جدًا بالنسبة لتيليجرام.',
    live: '📡 هذا بث مباشر، لذا لا يمكنني تنزيله بعد. أرسل لي التسجيل بعد انتهاء البث.',
    upcoming: '⏳ هذا البث لم يبدأ بعد، لذا لا يوجد ما يمكن تنزيله. أرسل لي التسجيل بعد انتهائه.',
  },
  fa: {
    help: '😎 لینک یک ویدیو را برایم بفرست تا خود ویدیو را برایت بفرستم.\n\nدر گروه‌ها هم کار می‌کنم: من را به گروه اضافه کن تا همه ویدیوهایی را که لینکشان آنجا فرستاده می‌شود دانلود کنم.',
    downloading: '⏬ در حال دانلود…',
    queued: '⏳ در صف: الان دارم ویدیوهای دیگری را دانلود می‌کنم و هر چه زودتر سراغ این یکی می‌روم…',
    restarting: '🔄 برای به‌روزرسانی دارم دوباره راه‌اندازی می‌شوم، برای همین این دانلود لغو شد. یک دقیقه دیگر دوباره لینک را بفرست.',
    uploading: '⏫ در حال آپلود…',
    failed: '😱 نتوانستم این ویدیو را دانلود کنم.',
    tooBig: '😱 این ویدیو برای تلگرام خیلی بزرگ است.',
    live: '📡 این یک پخش زنده است، برای همین هنوز نمی‌توانم دانلودش کنم. وقتی پخش تمام شد، ضبط آن را برایم بفرست.',
    upcoming: '⏳ این پخش هنوز شروع نشده، برای همین چیزی برای دانلود نیست. وقتی تمام شد، ضبط آن را برایم بفرست.',
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
