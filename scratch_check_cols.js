const db = require('./src/db');
async function run() {
    try {
        const cols = await db.query("SELECT RDB$FIELD_NAME FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = 'FACTF02'");
        console.log(cols.map(c => c['RDB$FIELD_NAME'].trim()).join(', '));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
run();
