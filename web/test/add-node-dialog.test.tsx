// The Add node dialog: live validation in the validator's wording, the normalized value, the duplicate check and its
// two offers, the parent picker and relation, and what is POSTed.
import { manualNodeSchema, nodeDetailResponseSchema, nodeId, type NodeType } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AddNodeDialog, type AddNodeDialogProps, type NodeRef } from '../src/edit/AddNodeDialog';
import { node } from './fixtures';

const EXISTING_IP = nodeId('ip', '10.0.0.1');
const DOMAIN: NodeRef = { id: nodeId('domain', 'example.com'), type: 'domain', value: 'example.com', label: 'example.com' };
const SUB: NodeRef = { id: nodeId('subdomain', 'api.example.com'), type: 'subdomain', value: 'api.example.com', label: 'api.example.com' };

function detail(id: string, type: NodeType, value: string) {
  return nodeDetailResponseSchema.parse({
    node: { ...node(id, { type, value, label: value }), data: {}, notes: '' },
    scope: { decision: 'out', reason: 'r', rule: null },
    edges: [],
    observations: [],
  });
}

function fakeApi() {
  const posts: unknown[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/nodes' && init?.method === 'POST') {
      const body: unknown = JSON.parse(init.body as string);
      posts.push(body);
      const parsed = manualNodeSchema.parse(body);
      if (parsed.ifExists === 'link') return Promise.resolve(json({ id: EXISTING_IP, created: false, linked: true, warnings: [] }));
      return Promise.resolve(json({ id: nodeId(parsed.type, parsed.value), created: true, linked: parsed.parentId !== undefined, warnings: [] }, 201));
    }
    if (url.startsWith('/api/nodes?')) {
      const params = new URLSearchParams(url.split('?')[1]);
      const items = 'example.com'.includes(params.get('q') ?? '') && (params.get('types') ?? '').split(',').includes('domain')
        ? [node(DOMAIN.id, { type: 'domain', value: 'example.com', label: 'example.com' })]
        : [];
      return Promise.resolve(json({ items, page: 1, pageSize: 8, total: items.length }));
    }
    if (url === `/api/nodes/${EXISTING_IP}`) return Promise.resolve(json(detail(EXISTING_IP, 'ip', '10.0.0.1')));
    return Promise.resolve(json({ error: 'not found' }, 404));
  });
  return { fetch, posts };
}

let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  api = fakeApi();
  vi.stubGlobal('fetch', api.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function open(props: Partial<AddNodeDialogProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = { onDone: vi.fn(), onSelectExisting: vi.fn(), onClose: vi.fn() };
  render(
    <QueryClientProvider client={client}>
      <AddNodeDialog parent={null} position={null} {...handlers} {...props} />
    </QueryClientProvider>,
  );
  return handlers;
}

function chooseType(type: NodeType) {
  fireEvent.click(screen.getByRole('button', { name: 'Type' }));
  fireEvent.click(screen.getByRole('option', { name: type }));
}

const typeValue = (value: string) => {
  fireEvent.change(screen.getByLabelText('Value'), { target: { value } });
};
const addButton = () => screen.getByRole('button', { name: 'Add node' });

describe('value', () => {
  test("invalid: the validator's message, and Add is disabled", () => {
    open();
    typeValue('Example.com');
    expect(screen.getByRole('alert').textContent).toBe("domain value 'Example.com' must be lowercase");
    expect(addButton()).toHaveProperty('disabled', true);

    chooseType('port');
    typeValue('10.0.0.1:80');
    expect(screen.getByRole('alert').textContent).toBe("port value '10.0.0.1:80' must look like ip:port/tcp, e.g. 93.184.216.34:443/tcp");
  });

  test('valid: shows the normalized value when it differs', async () => {
    open();
    chooseType('url');
    typeValue('https://a.example.com:443');
    expect(screen.getByText('https://a.example.com/')).toBeTruthy();
    expect(screen.getByText(/Stored as/)).toBeTruthy();
    await waitFor(() => {
      expect(addButton()).toHaveProperty('disabled', false);
    });
  });

  test('every type is in the dropdown, each with its icon', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'domain', 'subdomain', 'ip', 'port', 'url', 'technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak',
    ]);
    expect(options.every((o) => o.querySelector('img') !== null)).toBe(true);
  });

  test("the validator's warnings show as hints; severity is asked for the types that need one", () => {
    open();
    chooseType('vulnerability');
    typeValue('CVE-2024-0001');
    expect(within(screen.getByRole('list', { name: 'Warnings' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'vulnerability has no severity',
      'vulnerability has no parent; it will float alone on the graph',
    ]);
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'high' } });
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['vulnerability has no parent; it will float alone on the graph']);
    chooseType('domain');
    expect(screen.queryByLabelText('Severity')).toBeNull();
  });
});

describe('already in the graph', () => {
  test('says so, offers "Select existing node", and Add stays disabled', async () => {
    const h = open();
    chooseType('ip');
    typeValue('::ffff:10.0.0.1');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Already in the graph as 10.0.0.1');
    expect(within(status).queryByRole('button', { name: 'Add the parent link' })).toBeNull();
    expect(addButton()).toHaveProperty('disabled', true);
    fireEvent.click(within(status).getByRole('button', { name: 'Select existing node' }));
    expect(h.onSelectExisting).toHaveBeenCalledWith(EXISTING_IP);
  });

  test('with a parent: "Add the parent link" posts ifExists=link', async () => {
    const h = open({ parent: SUB });
    chooseType('ip');
    typeValue('10.0.0.1');
    fireEvent.click(within(await screen.findByRole('status')).getByRole('button', { name: 'Add the parent link' }));
    await waitFor(() => {
      expect(h.onDone).toHaveBeenCalledWith(EXISTING_IP);
    });
    expect(api.posts).toEqual([{ type: 'ip', value: '10.0.0.1', ifExists: 'link', parentId: SUB.id, relation: 'resolves_to' }]);
  });
});

describe('parent and relation', () => {
  test('"Add child node": only the types that can hang under the parent; the relation comes from the two types', () => {
    open({ parent: DOMAIN });
    expect(screen.getByRole('heading').textContent).toBe('Add child node under example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['subdomain', 'ip', 'url', 'email']);
    fireEvent.click(screen.getByRole('option', { name: 'ip' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Relation').value).toBe('resolves_to');
  });

  test('search a parent among the types that can be one, then submit with it', async () => {
    const h = open({ position: { x: 10, y: -20 } });
    chooseType('subdomain');
    typeValue('new.example.com');
    fireEvent.change(screen.getByLabelText('Search for a parent'), { target: { value: 'exa' } });
    fireEvent.click(await screen.findByRole('button', { name: /example\.com/ }));
    expect(screen.queryByLabelText('Search for a parent')).toBeNull();
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: '  New one ' } });
    fireEvent.change(screen.getByLabelText('Tag (optional)'), { target: { value: 'interesting' } });
    fireEvent.change(screen.getByLabelText('Notes (optional, markdown)'), { target: { value: 'found **by hand**' } });
    await waitFor(() => {
      expect(addButton()).toHaveProperty('disabled', false);
    });
    fireEvent.click(addButton());
    await waitFor(() => {
      expect(h.onDone).toHaveBeenCalledWith(nodeId('subdomain', 'new.example.com'));
    });
    expect(api.posts).toEqual([
      {
        type: 'subdomain',
        value: 'new.example.com',
        ifExists: 'return',
        parentId: DOMAIN.id,
        relation: 'has_subdomain',
        label: 'New one',
        tag: 'interesting',
        notes: 'found **by hand**',
        x: 10,
        y: -20,
      },
    ]);
    const search = api.fetch.mock.calls.map(([url]) => url).find((u) => u.startsWith('/api/nodes?'));
    expect(new URLSearchParams(search?.split('?')[1]).get('types')).toBe('domain');
  });

  test('no position (Tree mode, or a child): no x/y is sent', async () => {
    const h = open();
    typeValue('target.example');
    await waitFor(() => {
      expect(addButton()).toHaveProperty('disabled', false);
    });
    fireEvent.click(addButton());
    await waitFor(() => {
      expect(h.onDone).toHaveBeenCalled();
    });
    expect(api.posts).toEqual([{ type: 'domain', value: 'target.example', ifExists: 'return' }]);
  });

  test('a domain has no parent type', () => {
    open();
    expect(screen.getByText('A domain has no parent type: it is a root.')).toBeTruthy();
  });

  test('Escape and Cancel close it', () => {
    const h = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });
});
