// Initiate the single-node replica set if it isn't already, then block until
// this node is PRIMARY. Writes (and change streams) fail until it is.
try {
  rs.status();
  print('replica set already initiated');
} catch (e) {
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] });
  print('replica set initiated');
}

for (let i = 0; i < 60; i++) {
  if (db.hello().isWritablePrimary) {
    print('PRIMARY');
    quit(0);
  }
  sleep(500);
}
print('NOT PRIMARY after 30s');
quit(1);
