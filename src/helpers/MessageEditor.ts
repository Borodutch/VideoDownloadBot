import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'

export default class MessageEditor {
  private timer?: NodeJS.Timer

  constructor(
    public messageId: number,
    private ctx?: Context,
    public chatId?: number,
    private messages: string[] = [],
    private interval: number = 60
  ) {
    this.startEditing()
  }

  private get safeChatId() {
    return this.ctx?.dbchat.telegramId || this.chatId
  }

  private startEditing() {
    if (!this.messages.length) {
      return
    }
    this.timer = setInterval(() => this.updateMessage(), this.interval * 1000)
  }

  private async updateMessage() {
    const message = this.messages.shift()
    if (!message) {
      this.stopEditting()
      return
    }
    try {
      if (!this.safeChatId) {
        return
      }
      await bot.api.editMessageText(this.safeChatId, this.messageId, message)
    } catch (error) {
      report(error, { ctx: this.ctx, location: 'MessageEditor.updateMessage' })
    }
  }

  stopEditting() {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = undefined
  }

  changeMessages(messages: string[]) {
    this.stopEditting()
    this.messages = messages
    this.startEditing()
  }

  async editMessageAndStopTimer(message: string) {
    this.stopEditting()
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
