// scripts/demo-data.mjs — fill the database with made-up clinic data for demos.
//
//   node scripts/demo-data.mjs           add the demo data (once; refuses if it is already there)
//   node scripts/demo-data.mjs --reset   remove the demo data and add it again
//   node scripts/demo-data.mjs --remove  remove the demo data only
//
// Uses DATABASE_URL (or PG*) from .env like the API. Run it after the API has
// started once, so the migrations and the services seed are in place.
// Every demo patient has an e-mail ending in @demo.example.test, which is
// how --reset/--remove find them; nothing else in the database is touched.
// All names, phone numbers and IDs are fictional.

import { loadEnv } from '../api/lib/env.mjs';
import { close, query, tx } from '../api/db.mjs';

const DOMAIN = '@demo.example.test';

const PATIENTS = [
  // Obviously made-up people in made-up places.
  ['Ada', 'Example', '1988-03-14', 'F', 'Maple Town'],
  ['Ben', 'Sample', '1975-11-02', 'M', 'Riverside'],
  ['Cora', 'Testwell', '1992-07-21', 'F', 'Example Town'],
  ['Dev', 'Placeholder', '1969-01-30', 'M', 'Hillview'],
  ['Elle', 'Demo', '2001-05-09', 'F', 'Lakeside'],
  ['Finn', 'Fictional', '1983-09-17', 'M', 'Maple Town'],
  ['Gia', 'Mockridge', '1995-12-05', 'F', 'Riverside'],
  ['Hal', 'Specimen', '1958-04-26', 'M', 'Example Town'],
  ['Iris', 'Notreal', '1979-08-11', 'F', 'Hillview'],
  ['Jon', 'Doe-Demo', '1990-02-18', 'M', 'Lakeside'],
  ['Kit', 'Pretend', '1986-10-03', 'F', 'Maple Town'],
  ['Leo', 'Imaginary', '2005-06-24', 'M', 'Riverside'],
  ['Mia', 'Madeup', '1973-03-08', 'F', 'Example Town'],
  ['Ned', 'Dummy', '1998-11-29', 'M', 'Hillview'],
  ['Ola', 'Invented', '1964-07-15', 'F', 'Lakeside'],
  ['Pip', 'Testcase', '1981-12-22', 'M', 'Maple Town'],
];

const EXTRA_SERVICES = [
  ['DEMO_BP', 'Blood Pressure Check', 'Quick blood pressure reading', 50.0],
  ['DEMO_ECG', 'ECG', 'Resting electrocardiogram', 300.0],
  ['DEMO_DRESS', 'Wound Dressing', 'Cleaning and dressing of a minor wound', 90.0],
];

const REASONS = [
  'Fever and sore throat for 3 days',
  'Follow-up on blood pressure medication',
  'Lower back pain after lifting',
  'Routine check-up',
  'Persistent cough',
  'Rash on forearm',
  'Diabetes review and blood sugar log',
  'Headaches in the evenings',
  'Sprained ankle while playing football',
  'Prescription renewal',
];

const NOTES = [
  'Patient presented with mild symptoms. Vitals normal. Advised rest and fluids; review in one week if no improvement.',
  'BP 132/84. Continue current medication. Reduce salt intake. Recheck in one month.',
  'Muscular strain, no neurological signs. Prescribed analgesic and stretching exercises.',
  'General check-up complete. No concerns. Blood work ordered as routine.',
  'Chest clear on auscultation. Likely post-viral cough. Honey and warm fluids; return if worse.',
  'Contact dermatitis suspected. Topical steroid prescribed; avoid new detergent.',
];

// A time on a given day offset (0 = today, -3 = three days ago) at hh:mm local time.
function at(dayOffset, hh, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d;
}

async function demoPatientCount() {
  const r = await query('select count(*)::int as n from public.patients where email like $1', [`%${DOMAIN}`]);
  return r.rows[0].n;
}

async function remove() {
  return tx(async (c) => {
    // invoices only lose their appointment link when it goes, so delete them first
    await c.query(
      `delete from public.invoices where appointment_id in (
         select a.id from public.appointments a join public.patients p on p.id = a.patient_id
         where p.email like $1)`,
      [`%${DOMAIN}`]
    );
    const r = await c.query('delete from public.patients where email like $1', [`%${DOMAIN}`]);
    await c.query("delete from public.services where code like 'DEMO\\_%'");
    return r.rowCount;
  });
}

async function add() {
  return tx(async (c) => {
    for (const [code, name, description, price] of EXTRA_SERVICES) {
      await c.query(
        `insert into public.services (code, name, description, price, taxable, show_on_landing)
         values ($1, $2, $3, $4, false, true) on conflict (code) do nothing`,
        [code, name, description, price]
      );
    }
    const services = (await c.query('select id, name, price from public.services where active order by price')).rows;
    if (!services.length) throw new Error('no services found: start the API once so the migrations run first');

    const patients = [];
    for (const [i, [first, last, dob, sex, town]] of PATIENTS.entries()) {
      const r = await c.query(
        `insert into public.patients (first_name, last_name, date_of_birth, sex, phone, email, address, national_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          first, last, dob, sex,
          `+1 555 01${String(i).padStart(2, '0')}`,
          `${first}.${last}`.toLowerCase().replace(/\s+/g, '') + DOMAIN,
          `${10 + i} Main Road, ${town}`,
          `DEMO${String(19800000 + i * 1111)}`,
        ]
      );
      patients.push(r.rows[0].id);
    }

    const stats = { appointments: 0, notes: 0, invoices: 0, payments: 0 };
    const appointment = async (patient, start, status, reason, type) => {
      const r = await c.query(
        `insert into public.appointments (patient_id, scheduled_start, status, reason, customer_type)
         values ($1, $2, $3, $4, $5) returning id`,
        [patient, start, status, reason, type]
      );
      stats.appointments++;
      return r.rows[0].id;
    };

    // Past three weeks: completed visits with notes and invoices in every state.
    let n = 0;
    for (let day = -21; day <= -1; day++) {
      const weekday = at(day, 12).getDay();
      if (weekday === 0) continue; // the clinic is closed on Sundays
      const visits = 1 + (n % 3);
      for (let v = 0; v < visits; v++, n++) {
        const patient = patients[n % patients.length];
        const status = n % 11 === 5 ? 'no_show' : n % 13 === 7 ? 'canceled' : 'completed';
        const id = await appointment(patient, at(day, 16, v * 30), status, REASONS[n % REASONS.length],
          n % 2 ? 'appointment' : 'walk-in');
        if (status !== 'completed') continue;
        await c.query(`insert into public.visit_notes (appointment_id, notes) values ($1, $2)`,
          [id, NOTES[n % NOTES.length]]);
        stats.notes++;
        const inv = (await c.query(
          `insert into public.invoices (appointment_id, status, tax_enabled, tax_rate, created_at)
           values ($1, 'draft', false, 0, $2) returning id`,
          [id, at(day, 17, v * 30)]
        )).rows[0].id;
        stats.invoices++;
        const lines = [services[n % services.length], ...(n % 4 === 0 ? [services[(n + 2) % services.length]] : [])];
        for (const s of lines) {
          await c.query(
            `insert into public.invoice_items (invoice_id, service_id, description, quantity, unit_price, taxable)
             values ($1, $2, $3, 1, $4, false)`,
            [inv, s.id, s.name, s.price]
          );
        }
        // mostly paid; some part-paid, some unpaid, a few still drafts
        const kind = n % 7 === 3 ? 'draft' : n % 5 === 2 ? 'unpaid' : n % 6 === 1 ? 'part' : 'paid';
        if (kind === 'draft') continue;
        await c.query(`update public.invoices set status = 'issued' where id = $1`, [inv]);
        if (kind === 'unpaid') continue;
        const total = Number((await c.query('select total from public.invoices where id = $1', [inv])).rows[0].total);
        const amount = kind === 'part' ? Math.round(total / 2) : total;
        if (amount <= 0) continue;
        await c.query(
          `insert into public.payments (invoice_id, amount, method, reference, received_at)
           values ($1, $2, $3, $4, $5)`,
          [inv, amount, ['cash', 'card', 'transfer'][n % 3], n % 3 === 2 ? `TRF-${1000 + n}` : null,
            at(day, 17, 15 + v * 30)]
        );
        stats.payments++;
      }
    }

    // Today: a live queue — one with the doctor, two waiting, the rest booked for later.
    const today = [
      ['in_progress', 16, 0, 'walk-in'],
      ['waiting', 16, 30, 'walk-in'],
      ['waiting', 16, 45, 'appointment'],
      ['scheduled', 17, 15, 'appointment'],
      ['scheduled', 17, 45, 'appointment'],
      ['scheduled', 18, 30, 'appointment'],
    ];
    for (const [i, [status, hh, mm, type]] of today.entries()) {
      await appointment(patients[(i * 5) % patients.length], at(0, hh, mm), status, REASONS[(i + 3) % REASONS.length], type);
    }
    // The next few days: upcoming bookings.
    for (let i = 0; i < 6; i++) {
      await appointment(patients[(i * 3 + 1) % patients.length], at(1 + (i % 3), 16 + (i % 3), 0), 'scheduled',
        REASONS[(i + 5) % REASONS.length], 'appointment');
    }
    return { patients: patients.length, ...stats };
  });
}

async function main() {
  loadEnv();
  const args = new Set(process.argv.slice(2));
  if (args.has('--reset') || args.has('--remove')) {
    console.log(`removed ${await remove()} demo patient(s) and their visits, notes, invoices and payments`);
    if (args.has('--remove')) return;
  } else if (await demoPatientCount()) {
    console.log('demo data is already loaded; use --reset to load it again or --remove to take it out');
    return;
  }
  const s = await add();
  console.log(`added ${s.patients} patients, ${s.appointments} appointments, ${s.notes} visit notes, ` +
    `${s.invoices} invoices and ${s.payments} payments (all fictional)`);
}

main()
  .catch((e) => {
    console.error(`demo data failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(close);
