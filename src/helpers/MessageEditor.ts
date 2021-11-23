import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'

export default class MessageEditor {
  private timer?: NodeJS.Timer

  constructor(
    private ctx: Context,
    public messageId: number,
    private messageLocalizationKeys: string[] = [],
    private interval: number = 60
  ) {
    this.startEditing()
  }

  private startEditing() {
    if (!this.messageLocalizationKeys.length) {
      return
    }
    this.timer = setInterval(() => this.updateMessage(), this.interval * 1000)
  }

  private async updateMessage() {
    const messageLocalizationKey = this.messageLocalizationKeys.shift()
    if (!messageLocalizationKey) {
      this.stopEditting()
      return
    }
    try {
      await bot.api.editMessageText(
        this.ctx.dbchat.telegramId,
        this.messageId,
        this.ctx.i18n.t(messageLocalizationKey)
      )
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

  changeMessages(messageLocalizationKeys: string[]) {
    this.stopEditting()
    this.messageLocalizationKeys = messageLocalizationKeys
    this.startEditing()
  }

  async editMessageAndStopTimer(messageLocalizationKey: string) {
    this.stopEditting()
    try {
      await bot.api.editMessageText(
        this.ctx.dbchat.telegramId,
        this.messageId,
        this.ctx.i18n.t(messageLocalizationKey)
      )
    } catch (error) {
      report(error, {
        ctx: this.ctx,
        location: 'MessageEditor.editMessageAndStopTimer',
      })
    }
  }
}
