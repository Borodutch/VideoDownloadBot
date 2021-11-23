import { connect } from 'mongoose'

function startMongo() {
  if (!process.env.MONGO) {
    throw new Error('MONGO is not defined')
  }
  return connect(process.env.MONGO)
}

export default startMongo
