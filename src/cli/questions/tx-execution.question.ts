import { Question, QuestionSet } from 'nest-commander';

@QuestionSet({ name: 'tx-execution' })
export class TxExecutionQuestion {
  @Question({
    type: 'confirm',
    askAnswered: true,
    message: (answers: { txSummary?: string }) =>
      answers.txSummary
        ? `Send this transaction?\n${answers.txSummary}\nConfirm sending?`
        : 'Are you sure you want to send this transaction?',
    name: 'sendingConfirmed',
  })
  parseSendingConfirmed(val: boolean) {
    return val;
  }
}
