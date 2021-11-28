import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'

export default class MessageEditor {
  constructor(
    public messageId?: number,
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
      if (this.messageId) {
        await bot.api.editMessageText(this.safeChatId, this.messageId, message)
      } else if (this.ctx) {
        await this.ctx.reply(message)
      } else {
        throw new Error('No messageId or ctx found when editting')
      }
    } catch (error) {
      report(error, {
        ctx: this.ctx,
        location: 'MessageEditor.editMessage',
      })
    }
  }
}
