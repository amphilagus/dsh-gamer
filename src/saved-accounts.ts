import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  SavedAccountStore,
  validateSavedAccountSettings,
  type AccountCredentialStore,
  type AccountSettingsScope,
  type SavedAccount,
  type SavedAccountSettings,
} from './account-store.ts'

export * from './account-store.ts'

export const SAVED_ACCOUNT_SETTINGS_NAMESPACE = 'dsh-gamer'

const SavedAccountSchema: z<SavedAccount> = z.object({
  accountId: z.string().required(),
  platformId: z.string().required(),
  username: z.string().required(),
  credentialRef: z.string().required(),
  createdAt: z.string().required(),
  updatedAt: z.string().required(),
})

export const SavedAccountSettingsSchema: z<SavedAccountSettings> = z.object({
  accounts: z.dict(SavedAccountSchema).default({}),
})

export function createSavedAccountStore(ctx: Context): SavedAccountStore {
  const namespace = settingsNamespace(SAVED_ACCOUNT_SETTINGS_NAMESPACE)
  const registered = ctx.settings.register<SavedAccountSettings>(
    namespace,
    SavedAccountSettingsSchema,
    { applies: 'live', validate: validateSavedAccountSettings },
  )
  const scope: AccountSettingsScope = {
    get: () => registered.get(),
    mutate: (ops) => ctx.settings.mutate(namespace, ops),
  }
  const credentials: AccountCredentialStore = {
    resolve: (ref) => ctx.credentials.resolve(credentialRef(ref)),
    describe: (ref) => ctx.credentials.describe(credentialRef(ref)),
    set: (ref, value) => ctx.credentials.set(credentialRef(ref), value),
    unset: (ref) => ctx.credentials.unset(credentialRef(ref)),
  }
  return new SavedAccountStore(scope, credentials)
}
