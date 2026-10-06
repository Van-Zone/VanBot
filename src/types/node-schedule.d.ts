declare module "node-schedule" {
  export class RecurrenceRule {
    year?: number
    month?: number
    date?: number
    hour?: number
    minute?: number
    second?: number
    dayOfWeek?: number
    tz?: string
  }
  export interface Job {
    cancel(): boolean
    reschedule(spec: string | Date | RecurrenceRule): boolean
    nextInvocation(): Date
  }
  export function scheduleJob(spec: string | Date | RecurrenceRule, callback: () => void): Job
  export function cancelJob(job: Job): boolean
  export const gracefulShutdown: () => Promise<void>
}
