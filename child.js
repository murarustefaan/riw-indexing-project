const Metadata = require('./src/Metadata');
const Indexing = require('./src/Indexes');
const MongoClient = require('mongodb').MongoClient;

let dbConnection = null;
let db = null;
let docsCollection = null;
let directIndexCollection = null;
let reverseIndexCollection = null;

process.on('message', async (message, socket) => {

  if (dbConnection === null) {
    try {
      dbConnection = await MongoClient.connect('mongodb://localhost:27017');
      db = await dbConnection.db('riw');
      docsCollection = await db.collection('documents');
      directIndexCollection = await db.collection('direct-index');
      reverseIndexCollection = await db.collection('reverse-index');
    } catch (e) {
      console.error(`Process ${process.pid} could not create MongoDB connection, reason: ${e}`);
      process.exit(1);
    }
  }

  switch(message.type) {

    case 'text_processing': {

      const filename = message.name.replace(/\\/g, '\\');

      try {
        const {rawContent, parsedContent} = await Metadata.extractTextSync(message.name);

        await docsCollection
          .update({
            name: filename
          }, {
            name: filename,
            rawContent,
            parsedContent
          }, {
            upsert: true
          });
      } catch (e) {
        console.error(`Process ${process.pid} could not add document's ${message.name} contents to db, reason ${e}`);
      }

      return process.send({type: message.type, jobs: [ filename ]});
    }

    case 'direct_index': {
      const filename = message.name.replace(/\\/g, '\\');
      let dbDocument = null;

      try {
        dbDocument = await docsCollection.findOne({name: filename}, {parsedContent: 1});
      } catch (e) {
        console.error(`Process ${process.pid} could not retrieve document's ${message.name} parsed contents from db, reason ${e}`)

        return process.send({type: message.type, jobs: [ ]});
      }

      const { index, frequencies } = Indexing.createDirectIndexFromText(dbDocument.parsedContent);

      try {
        await directIndexCollection
          .update({
            name: filename
          }, {
            name: filename,
            words: index,
            frequencies
          }, {
            upsert: true
          });
      } catch (e) {
        console.error(`Process ${process.pid} could not add document's ${message.name} direct-index to db, reason ${e}`);
      }

      return process.send({type: message.type, jobs: [ ...Object.keys(index) ]});
    }

    case 'reverse_index': {
      try {
        const pipeline = Indexing.GetReverseIndexingPipelineStages(message.name);

        const results = await directIndexCollection.aggregate(pipeline);
        const docs = await results.toArray();
        const doc = docs[0];

        if (!doc) {
          console.warn(`Reverse indexing did not return results for word ${message.name}`);
          return process.send({type: message.type, jobs: [ message.name ]});
        }

        const reverseFrequency = Math.log(message.numberOfDocumentsToIndex / (1 + doc.documents.length));

        const reverseIndex = Object.assign(doc, { word: message.name, reverseFrequency  });
        reverseIndex.documents = reverseIndex.documents.map(d => { d.tfidf = d.frequency * reverseFrequency; return d; });
        delete reverseIndex['_id'];

        await reverseIndexCollection
          .update(
            { word: message.name },
            reverseIndex,
            { upsert: true }
          );
      } catch (e) {
        console.error(e);
      }

      return process.send({type: message.type, jobs: [ message.name ]});
    }
  }
});

process.on('beforeExit', async () => {
  if (dbConnection !== null) {
    dbConnection.close();
  }
});
