import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'

export default class MessageEditor {
  constructor(
    public messageId: number,
    private ctx?: Context,
    public chatId?: number
  ) {}

  private get safeChatId() {
    return this.ctx?.dbchat.telegramId || this.chatId
  }

  async editMessage(message: string) {
    try {
      if (!this.safeChatId) {
        return
      }
      await bot.api.editMessageText(this.safeChatId, this.messageId, message)
    } catch (error) {
      report(error, {
        ctx: this.ctx,
        location: 'MessageEditor.editMessageAndStopTimer',
      })
    }
  }
}
