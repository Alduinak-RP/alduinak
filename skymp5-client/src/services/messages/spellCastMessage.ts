import { MsgType } from "../../messages";

export interface SpellCastMsgData {
    caster: number
    target: number
    spell: number
    isDualCasting: boolean
    interruptCast: boolean
    // Required by the native parser; true only for keep-alive resends of a channeled cast
    keepAlive: boolean
    castingSource: number
    aimAngle: number,
    aimHeading: number,
    actorAnimationVariables: {
        booleans: number[]
        floats: number[]
        integers: number[]
    }
}

export interface SpellCastMessage {
    t: MsgType.SpellCast,
    data: SpellCastMsgData
}
