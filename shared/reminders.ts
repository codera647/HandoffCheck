import { z } from 'zod';

export const reminderInputSchema = z
  .object({
    enabled: z.boolean(),
    emailEnabled: z.boolean(),
    intervalMinutes: z.number().int().min(15).max(10080),
    expectedRevision: z.number().int().positive(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ReminderInput = z.infer<typeof reminderInputSchema>;
export const reminderSettingsSchema = z.object({
  enabled: z.boolean(),
  emailEnabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(10080),
  version: z.number().int().nonnegative(),
  custom: z.boolean(),
  state: z.enum(['off', 'waiting', 'scheduled', 'stopped']),
  nextDueAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  schedulerConfigured: z.boolean(),
  emailConfigured: z.boolean(),
  emailStatus: z.enum(['off', 'waiting', 'queued', 'sending', 'sent', 'failed', 'uncertain']),
  senderConnected: z.boolean().default(false),
  senderEmail: z.string().nullable().default(null),
  senderError: z.string().nullable().default(null),
  lastEmailSentAt: z.string().nullable(),
  demo: z.boolean(),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;
export const disabledReminders: ReminderSettings = {
  enabled: false,
  emailEnabled: true,
  intervalMinutes: 1440,
  version: 0,
  custom: false,
  state: 'off',
  nextDueAt: null,
  lastSentAt: null,
  schedulerConfigured: false,
  emailConfigured: false,
  emailStatus: 'off',
  senderConnected: false,
  senderEmail: null,
  senderError: null,
  lastEmailSentAt: null,
  demo: false,
};
