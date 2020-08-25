const micro = require("micro")
const { createError, json } = micro
const axios = require("axios")
const IotApi = require("@arduino/arduino-iot-client")
const { ArduinoIoTCloud } = require("arduino-iot-js")

const { CLIENT_ID, CLIENT_SECRET } = process.env
const DEVICE_TYPE = "mkrwifi1010"

const getToken = async () => {
  const resp = await axios.post(
    "https://api2.arduino.cc/iot/v1/clients/token",
    {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: "https://api2.arduino.cc/iot",
    }
  )
  IotApi.ApiClient.instance.authentications.oauth2.accessToken =
    resp.data.access_token
}

const connectIoT = async (onDisconnect) => {
  await ArduinoIoTCloud.connect({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    onDisconnect: (message) => console.error("IoT disconnected", message),
  })
}

const init = () => Promise.all([getToken(), connectIoT()])

const getProperties = async ({ retry = false } = {}) => {
  const devicesApi = new IotApi.DevicesV2Api(IotApi.ApiClient.instance)
  const thingsApi = new IotApi.ThingsV2Api(IotApi.ApiClient.instance)

  try {
    const device = await devicesApi
      .devicesV2List()
      .then(
        (devices) =>
          devices &&
          devices
            .sort((a, b) => b.last_activity_at - a.last_activity_at)
            .find((d) => d.type === DEVICE_TYPE)
      )

    if (!device) {
      throw createError(500, "No compatible Device could be found")
    }

    const thing = await thingsApi
      .thingsV2List({
        deviceId: device.id,
        showProperties: true,
      })
      .then(
        (things) =>
          things && things.sort((a, b) => b.updated_at - a.updated_at)[0]
      )

    if (!thing) {
      throw createError(500, "No compatible Thing could be found")
    }

    if (!thing.properties) {
      throw createError(500, "No properties found on Thing")
    }

    return {
      id: thing.id,
      properties: thing.properties.reduce((acc, property) => {
        acc[property.variable_name] = property.last_value
        return acc
      }, {}),
    }
  } catch (e) {
    if (
      !retry &&
      e.status === 401 &&
      e.body &&
      e.body.code === "unauthorized"
    ) {
      await getToken()
      return await getProperties({ retry: true })
    }

    if (!(e instanceof Error)) {
      // Make micro accept the kind of errors IotApi throws
      throw createError(500, `${e.body.code}: ${e.body.detail}`, e)
    }

    throw e
  }
}

const setProperties = async (req) => {
  const data = await json(req)
  const thing = await getProperties()

  await Promise.all(
    Object.entries(data.properties)
      .filter(([name, value]) => value !== properties[name])
      .map(([name, value]) =>
        ArduinoIoTCloud.sendProperty(thing.id, name, value)
      )
  )

  return getProperties()
}

const onPropertyUpdate = (thingId, propertyName, onUpdate) => {
  return ArduinoIoTCloud.onPropertyValue(thingId, propertyName, (value) => {
    onUpdate({ [property]: value })
  })
}

module.exports = {
  init,
  getProperties,
  setProperties,
  onPropertyUpdate,
}
