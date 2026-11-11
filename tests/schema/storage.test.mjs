// tests/schema/storage.test.mjs — storage_buckets / storage_objects, the local
// equivalent of the hosted object-storage metadata (task t2, 0006_storage.sql).

const columnsOf = async (client, table) =>
  (
    await client.query(
      `select column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = 'public' and table_name = $1`,
      [table]
    )
  ).rows;

export default [
  {
    name: 'storage_buckets and storage_objects have the ported columns',
    async fn({ client }) {
      const buckets = Object.fromEntries((await columnsOf(client, 'storage_buckets')).map((c) => [c.column_name, c]));
      const wantBuckets = {
        id: ['text', 'NO'],
        public: ['boolean', 'NO'],
      };
      for (const [name, [type, nullable]] of Object.entries(wantBuckets)) {
        const c = buckets[name];
        if (!c) throw new Error(`storage_buckets.${name} missing (${Object.keys(buckets).join(', ')})`);
        if (c.data_type !== type) throw new Error(`storage_buckets.${name} is ${c.data_type}, expected ${type}`);
        if (c.is_nullable !== nullable)
          throw new Error(`storage_buckets.${name} nullability is ${c.is_nullable}`);
      }

      const objects = Object.fromEntries((await columnsOf(client, 'storage_objects')).map((c) => [c.column_name, c]));
      const wantObjects = {
        id: ['uuid', 'NO'],
        bucket: ['text', 'NO'],
        name: ['text', 'NO'],
        owner: ['uuid', 'YES'],
        mime: ['text', 'YES'],
        bytes: ['bigint', 'YES'],
        sha256: ['text', 'YES'],
        created_at: ['timestamp with time zone', 'NO'],
      };
      for (const [name, [type, nullable]] of Object.entries(wantObjects)) {
        const c = objects[name];
        if (!c) throw new Error(`storage_objects.${name} missing (${Object.keys(objects).join(', ')})`);
        if (c.data_type !== type) throw new Error(`storage_objects.${name} is ${c.data_type}, expected ${type}`);
        if (c.is_nullable !== nullable)
          throw new Error(`storage_objects.${name} nullability is ${c.is_nullable}, expected ${nullable}`);
      }
    },
  },
  {
    name: 'the signatures and exports buckets exist and are private',
    async fn({ client }) {
      const r = await client.query(
        "select id, public from public.storage_buckets where id in ('signatures','exports') order by id"
      );
      if (r.rowCount !== 2) throw new Error(`expected 2 buckets, got ${r.rowCount}`);
      for (const row of r.rows) {
        if (row.public !== false) throw new Error(`${row.id} bucket is public, expected private`);
      }
    },
  },
  {
    name: 'an object row records the bucket, name, mime, bytes, sha256 and owner',
    async fn({ client }) {
      const uid = (
        await client.query(
          "insert into public.app_users (email, password_hash) values ('up@example.test','h') returning id"
        )
      ).rows[0].id;
      const r = await client.query(
        `insert into public.storage_objects (bucket, name, owner, mime, bytes, sha256)
         values ('signatures', 'sig/abc.png', $1, 'image/png', 4321, $2)
         returning id, bucket, name, owner, mime, bytes, sha256, created_at`,
        [uid, 'a'.repeat(64)]
      );
      const row = r.rows[0];
      if (!/^[0-9a-f-]{36}$/.test(row.id)) throw new Error(`id default is ${row.id}`);
      if (row.bucket !== 'signatures' || row.name !== 'sig/abc.png')
        throw new Error(`bucket/name came back as ${row.bucket}/${row.name}`);
      if (row.owner !== uid) throw new Error(`owner is ${row.owner}`);
      if (row.mime !== 'image/png') throw new Error(`mime is ${row.mime}`);
      if (row.bytes !== '4321') throw new Error(`bytes is ${row.bytes} (type ${typeof row.bytes})`);
      if (row.sha256 !== 'a'.repeat(64)) throw new Error(`sha256 is ${row.sha256}`);
      if (!(row.created_at instanceof Date)) throw new Error('created_at is not a timestamptz');
    },
  },
  {
    name: '(bucket, name) is unique but the same name may live in another bucket',
    async fn({ client, expectError }) {
      await client.query(
        "insert into public.storage_objects (bucket, name, bytes) values ('signatures','dup.png',1)"
      );
      await expectError(
        () =>
          client.query("insert into public.storage_objects (bucket, name, bytes) values ('signatures','dup.png',2)"),
        '23505'
      );
      await client.query("insert into public.storage_objects (bucket, name, bytes) values ('exports','dup.png',2)");
    },
  },
  {
    name: 'an object must name a bucket that exists, and goes with its bucket',
    async fn({ client, expectError }) {
      await expectError(
        () => client.query("insert into public.storage_objects (bucket, name) values ('nope','x.png')"),
        '23503'
      );
      await client.query("insert into public.storage_buckets (id, public) values ('probe-bucket', true)");
      await client.query("insert into public.storage_objects (bucket, name) values ('probe-bucket','x.png')");
      await client.query("delete from public.storage_buckets where id = 'probe-bucket'");
      const r = await client.query("select 1 from public.storage_objects where bucket = 'probe-bucket'");
      if (r.rowCount) throw new Error(`${r.rowCount} object rows survived the bucket delete`);
    },
  },
  {
    name: 'the two bucket seeds survive a replay of every migration',
    async fn({ client, root }) {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const f of readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
        await client.query(readFileSync(join(root, 'db', 'migrations', f), 'utf8'));
      }
      const r = await client.query('select count(*)::int n from public.storage_buckets');
      if (r.rows[0].n !== 2) throw new Error(`storage_buckets has ${r.rows[0].n} rows after replay, expected 2`);
    },
  },
];
