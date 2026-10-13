import { baselineFields, emptyFields, type AppContext, type DraftInput } from '../shared/contracts';
export const ids = {
  author: '10000000-0000-4000-8000-000000000001',
  product: '10000000-0000-4000-8000-000000000002',
  engineering: '10000000-0000-4000-8000-000000000003',
  admin: '10000000-0000-4000-8000-000000000004',
  outsider: '10000000-0000-4000-8000-000000000005',
  workspace: '20000000-0000-4000-8000-000000000001',
  checklist: '30000000-0000-4000-8000-000000000001',
};
export const context: AppContext = {
  workspace: {
    id: ids.workspace,
    name: 'Test team',
    timezone: 'Asia/Karachi',
    reviewMode: 'checklist_only',
    storageBytes: 0,
    retentionDays: 60,
  },
  currentUser: { id: ids.author, name: 'Author', role: 'member', status: 'active' },
  members: [
    { id: ids.author, name: 'Author', role: 'member', status: 'active' },
    { id: ids.product, name: 'Product lead', role: 'product_lead', status: 'active' },
    { id: ids.engineering, name: 'Engineering lead', role: 'engineering_lead', status: 'active' },
    { id: ids.admin, name: 'Administrator', role: 'admin', status: 'active' },
  ],
  checklist: {
    id: ids.checklist,
    name: 'Test checklist',
    requiredFields: baselineFields,
    createdAt: new Date().toISOString(),
  },
};
export function asActor(id: string): AppContext {
  return { ...context, currentUser: context.members.find((m) => m.id === id)! };
}
export function draft(): DraftInput {
  const fields = emptyFields();
  for (const key of baselineFields) if (key !== 'criteria') fields[key] = 'Specified behavior';
  fields.title = 'Export reports';
  fields.criteria = ['Given a permitted user, export matching report rows.'];
  return {
    fields,
    productReviewerId: ids.product,
    engineeringReviewerId: ids.engineering,
    checklistVersion: ids.checklist,
    fileIds: [],
  };
}
