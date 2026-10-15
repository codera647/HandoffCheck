import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { fieldsSchema } from '../shared/contracts';
import {
  verifyBridgeSignature,
  bridgeActionSchema,
  intakeFormUrlSchema,
} from '../shared/workspace-bridge';

describe('Google Workspace boundaries', () => {
  it.each([false, true])(
    'sets up typed Form items and reuses them on retry (partial setup: %s)',
    async (partialSetup) => {
      const source = await readFile('google-workspace/Code.js', 'utf8');
      const values: Record<string, string> = { WORKSPACE_BRIDGE_SECRET: 'a'.repeat(64) };
      const items: Array<{
        type: string;
        title: string;
        required: boolean;
        choices: string[];
        getId(): number;
        getTitle(): string;
        setTitle(title: string): unknown;
        setRequired(required: boolean): unknown;
        setChoiceValues(choices: string[]): unknown;
      }> = [];
      function addItem(type: string) {
        const id = items.length + 1;
        const item = {
          type,
          title: '',
          required: false,
          choices: [] as string[],
          getId: () => id,
          getTitle() {
            return this.title;
          },
          setTitle(title: string) {
            this.title = title;
            return this;
          },
          setRequired(required: boolean) {
            this.required = required;
            return this;
          },
          setChoiceValues(choices: string[]) {
            this.choices = choices;
            return this;
          },
        };
        // Concrete items deliberately have no asTextItem()/other cast methods.
        items.push(item);
        return item;
      }
      if (partialSetup) {
        Object.assign(values, { FORM_ID: 'form', SHEET_ID: 'sheet', FOLDER_ID: 'folder' });
        addItem('text').setTitle('Feature title');
      }
      const intake = {
        getId: () => 'form',
        supportsAdvancedResponderPermissions: () => true,
        setPublished: () => {},
        setAcceptingResponses: () => {},
        setDescription: () => {},
        setConfirmationMessage: () => {},
        setAllowResponseEdits: () => {},
        setDestination: () => {},
        getPublishedUrl: () => 'https://docs.google.com/forms/d/e/published_1234567890/viewform',
        getItems: () =>
          items.map((item) => ({
            getTitle: () => item.title,
            asTextItem: () => {
              expect(item.type).toBe('text');
              return item;
            },
            asParagraphTextItem: () => {
              expect(item.type).toBe('paragraph');
              return item;
            },
            asListItem: () => {
              expect(item.type).toBe('choice');
              return item;
            },
          })),
        addTextItem: () => addItem('text'),
        addParagraphTextItem: () => addItem('paragraph'),
        addListItem: () => addItem('choice'),
      };
      const handlers: string[] = [];
      const configured: { formUrl: string }[] = [];
      const setup = runInNewContext(
        `${source}\nformsApi_ = function() {}; verifiedForm_ = function() {};
        table_ = function() {}; bridge_ = captureBridge; setupWorkspace;`,
        {
          captureBridge: (action: string, data: { formUrl: string }) => {
            if (action === 'configure') configured.push(data);
          },
          Session: { getEffectiveUser: () => ({ getEmail: () => 'moiz44386@gmail.com' }) },
          PropertiesService: {
            getScriptProperties: () => ({
              getProperty: (key: string) => values[key] || null,
              setProperty: (key: string, value: string) => {
                values[key] = value;
              },
            }),
          },
          LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
          SpreadsheetApp: { create: () => ({ getId: () => 'sheet' }) },
          Drive: { Files: { create: () => ({ id: 'folder' }) } },
          FormApp: {
            create: () => intake,
            openById: () => intake,
            DestinationType: { SPREADSHEET: 'sheet' },
          },
          ScriptApp: {
            getProjectTriggers: () => handlers.map((name) => ({ getHandlerFunction: () => name })),
            newTrigger: (name: string) => {
              const trigger = {
                forForm: () => trigger,
                onFormSubmit: () => trigger,
                timeBased: () => trigger,
                everyMinutes: () => trigger,
                create: () => handlers.push(name),
              };
              return trigger;
            },
          },
          console: { log() {} },
        },
      ) as () => void;
      setup();
      const mapping = values.ITEM_MAP;
      expect(items).toHaveLength(16);
      expect(items[0].required).toBe(true);
      expect(items.find((item) => item.title === 'Priority')?.choices).toEqual([
        'normal',
        'low',
        'high',
      ]);
      setup();
      expect(items).toHaveLength(16);
      expect(values.ITEM_MAP).toBe(mapping);
      expect(new Set(Object.values(JSON.parse(mapping))).size).toBe(16);
      expect(handlers).toEqual(['onFeatureSubmit', 'syncWorkspace']);
      expect(configured).toHaveLength(2);
      expect(configured[0].formUrl).toBe(intake.getPublishedUrl());
    },
  );
  it('accepts published intake URLs and rejects editor or misleading destinations', () => {
    expect(
      intakeFormUrlSchema.safeParse(
        'https://docs.google.com/forms/d/e/published_1234567890/viewform',
      ).success,
    ).toBe(true);
    for (const url of [
      'https://docs.google.com/forms/d/form_1234567890/edit',
      'https://docs.google.com.evil.test/forms/d/e/published_1234567890/viewform',
      'javascript:alert(1)',
    ])
      expect(intakeFormUrlSchema.safeParse(url).success).toBe(false);
  });
  it('verifies exact signed content, nonce and timestamp, rejecting tampering and expiry', async () => {
    const secret = 'a'.repeat(64),
      timestamp = String(Date.now()),
      nonce = crypto.randomUUID(),
      body = JSON.stringify({ action: 'sync', data: { after: 0 } });
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}\n${nonce}\n${body}`)
      .digest('hex');
    expect(await verifyBridgeSignature(secret, body, timestamp, nonce, signature)).toBe(true);
    expect(await verifyBridgeSignature(secret, body + ' ', timestamp, nonce, signature)).toBe(
      false,
    );
    expect(
      await verifyBridgeSignature(secret, body, timestamp, crypto.randomUUID(), signature),
    ).toBe(false);
    expect(
      await verifyBridgeSignature(
        secret,
        body,
        timestamp,
        nonce,
        signature,
        Number(timestamp) + 300001,
      ),
    ).toBe(false);
    expect(await verifyBridgeSignature(secret, body, 'NaN', nonce, signature)).toBe(false);
    expect(bridgeActionSchema.safeParse({ action: 'approve', data: {} }).success).toBe(false);
  });
  it('maps Form answers to the existing field contract and renders user text as literal cells', async () => {
    const source = await readFile('google-workspace/Code.js', 'utf8');
    const helpers = runInNewContext(
      `${source}\n({ fieldsFromAnswers_, literalCell_, docLine_ })`,
    ) as {
      fieldsFromAnswers_: (data: object) => unknown;
      literalCell_: (s: string) => string;
      docLine_: (s: string) => object;
    };
    const fields = fieldsSchema.parse(
      helpers.fieldsFromAnswers_({
        title: 'Test',
        criteria: 'One\nTwo',
        references: 'Design | https://example.com/design\nhttps://example.com/context',
      }),
    );
    expect(fields.criteria).toEqual(['One', 'Two']);
    expect(fields.references).toHaveLength(2);
    expect(fields.unscheduled).toBe(true);
    for (const cell of ['=IMPORTXML("https://evil.test")', '+123', '-2', '@SUM(A1)', '\t=1'])
      expect(helpers.literalCell_(cell).startsWith("'")).toBe(true);
    expect(helpers.literalCell_('Normal title')).toBe('Normal title');
    expect(helpers.docLine_('## Problem')).toEqual({ heading: 2, bullet: false, text: 'Problem' });
    expect(helpers.docLine_('- \\<script\\>')).toEqual({
      heading: 0,
      bullet: true,
      text: '<script>',
    });
  });
});
