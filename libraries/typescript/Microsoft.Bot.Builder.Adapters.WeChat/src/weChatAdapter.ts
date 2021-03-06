/**
 * @module botframework-wechat
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {Activity, ActivityTypes, BotAdapter, ConversationReference, ResourceResponse, TurnContext } from 'botbuilder-core';
import { Storage } from 'botbuilder-core';
import { WeChatClient } from './weChatClient';
import { IRequestMessageBase, SecretInfo, IResponseMessageBase, ResponseMessageTypes, TextResponse, ImageResponse, NewsResponse, MusicResponse, MPNewsResponse, VideoResponse, VoiceResponse, UploadMediaResult, MessageMenuResponse } from './weChatSchema';
import { WeChatMessageMapper } from './weChatMessageMapper';
import * as xml2js from 'xml2js';
import { VerificationHelper } from './verificationHelper';
import { MessageCryptography } from './messageCryptography';

/**
 * Express or Restify Request object.
 */
export interface WebRequest {
    body?: any;
    headers: any;
    on(event: string, ...args: any[]): any;
}

/**
 * Express or Restify Response object.
 */
export interface WebResponse {
    end(...args: any[]): any;
    send(body: any): any;
    status(status: number): any;
}

/**
 * Settings used to configure a `WeChatAdapter` instance.
 */
export interface WeChatAdapterSettings {
    AppId: string;
    AppSecret: string;
    Token: string;
    EncodingAESKey: string;
    UploadTemporaryMedia: boolean;
    PassiveResponse: boolean;
}

/**
 * Represents a adapter that can connect a bot to WeChat endpoint.
 */
export class WeChatAdapter extends BotAdapter {
    /**
     * Key to get all response from bot in a single turn.
     */
    private TurnResponseKey = Symbol('turnResponse');

    private weChatMessageMapper: WeChatMessageMapper;
    private weChatClient: WeChatClient;
    private passiveResponse: boolean;
    protected readonly settings: WeChatAdapterSettings;

    /**
     * Creates an instance of we chat adapter.
     * @param storage
     * @param settings configuration settings for the adapter.
     */
    constructor(storage: Storage, settings: WeChatAdapterSettings) {
        super();
        this.settings = {
            AppId: undefined,
            AppSecret: undefined,
            Token: undefined,
            EncodingAESKey: undefined,
            UploadTemporaryMedia: undefined,
            PassiveResponse: undefined,
            ...settings
        };
        this.weChatClient = new WeChatClient(this.settings.AppId, this.settings.AppSecret, storage);
        this.weChatMessageMapper = new WeChatMessageMapper(this.weChatClient, this.settings.UploadTemporaryMedia);
        this.passiveResponse = this.settings.PassiveResponse;
    }

    /**
     * Resume a conversation with a user, possibly after some time has gone by.
     * @param reference A `ConversationReference` saved during a previous incoming activity.
     * @param logic A function handler that will be called to perform the bots logic after the the adapters middleware has been run.
     * @returns conversation
     */
    public async continueConversation(reference: Partial<ConversationReference>, logic: (context: TurnContext) => Promise<void>): Promise<void> {
        const request: Partial<Activity> = TurnContext.applyConversationReference({ type: 'event', name: 'continueConversation' }, reference,true);
        const context: TurnContext = this.createContext(request);

        await this.runMiddleware(context, logic as any);
    }

    /**
     * Allows for the overriding of the context object in unit tests and derived adapters.
     * @param request Received request.
     */
    protected createContext(request: Partial<Activity>): TurnContext {
        return new TurnContext(this as any, request);
    }

    /**
     * Process the request from WeChat.
     * @param wechatRequest Request message entity from wechat.
     * @param logic A function handler that will be called to perform the bots logic after the the adapters middleware has been run.
     * @param passiveResponse Marked the message whether it needs passive reply or not.
     * @returns Response message entity.
     */
    public async processWeChatRequest(wechatRequest: IRequestMessageBase, logic: (context: TurnContext) => Promise<any>): Promise<any> {
        const activities = [];
        const activity = await this.weChatMessageMapper.toConnectorMessage(wechatRequest);
        const context = new TurnContext(this, activity as Activity);
        context.turnState.set(this.TurnResponseKey, activities);
        await this.runMiddleware(context, logic);
        const response = await this.processBotResponse(activities, wechatRequest.FromUserName);
        return response;
    }

    /**
     * Does not support by WeChat.
     */
    public async deleteActivity(context: TurnContext, reference: Partial<ConversationReference>): Promise<void> {
        throw new Error('WeChat does not support deleting activities.');
    }

    /**
     * Does not support by WeChat.
     */
    public async updateActivity(context: TurnContext, activity: Partial<Activity>): Promise<void> {
        throw new Error('WeChat does not support updating activities.');
    }

    /**
     * Sends a set of outgoing activities to WeChat.
     * @param context Context for the current turn of conversation with the user.
     * @param activities List of activities to send.
     * @returns Response activities
     */
    public async sendActivities(context: TurnContext, activities: Activity[]): Promise<ResourceResponse[]> {
        const resourceResponses: ResourceResponse[] = [];
        const activityList = context.turnState.get(this.TurnResponseKey);
        for (let i = 0; i < activities.length; i++) {
            const activity: Activity = activities[i];
            switch (activity.type) {
                case ActivityTypes.Message:
                case ActivityTypes.EndOfConversation:
                    activityList.push(activity);
                    const resourceResponse: ResourceResponse = { id: activity.id || undefined };
                    resourceResponses.push(resourceResponse);
                    break;
                case 'delay':
                    await delay(typeof activity.value === 'number' ? activity.value : 1000);
                    resourceResponses.push( {} as ResourceResponse);
                    break;
                default:
                    const otherResponse: ResourceResponse = { id: activity.id || undefined };
                    resourceResponses.push(otherResponse);
                    break;
            }
        }
        return resourceResponses;
    }

    /**
     * Process the request from WeChat.
     * @param req The request sent from WeChat.
     * @param res Http response object of current request.
     * @param logic A function handler that will be called to perform the bots logic after the the adapters middleware has been run.
     * @param secretInfo Secret info for verify the request.
     * @param passiveResponse If using passvice response mode, if set to true, user can only get one reply.
     * @returns Process activity result.
     */
    public async processActivity(req: WebRequest, res: WebResponse, logic: (context: TurnContext) => Promise<any>, secretInfo: SecretInfo): Promise<void> {
        if (!req) {
            throw new Error(`ArgumentError - Request is invalid.`);
        }

        if (!res) {
            throw new Error(`ArgumentError - Response is invalid.`);
        }

        if (!logic) {
            throw new Error(`ArgumentError - Bot logic is invalid.`);
        }

        if (!secretInfo) {
            throw new Error(`ArgumentError - Secret information is invalid.`);
        }

        if (!VerificationHelper.verifySignature(secretInfo.Signature, secretInfo.Timestamp, secretInfo.Nonce, this.settings.Token)) {
            throw new Error('UnauthorizedAccessException - Signature verification failed.');
        }

        secretInfo.Token = this.settings.Token;
        secretInfo.EncodingAesKey = this.settings.EncodingAESKey;
        secretInfo.AppId = this.settings.AppId;
        const weChatRequest = await parseRequest(req, secretInfo);
        if (!this.passiveResponse) {
            this.processWeChatRequest(weChatRequest, logic);
            // Return status
            res.status(200);
            res.end();
        } else {
            // TODO: Passive reply
        }
    }

    /**
     * Get access token depends on the current settings.
     * @param forceRefresh If force refresh the token.
     * @returns The access token string.
     */
    public async getWeChatAccessToken(forceRefresh: boolean): Promise<string> {
        const accessToken = await this.weChatClient.getAccessTokenAsync(forceRefresh);
        return accessToken;
    }

    /**
     * Get the respone from bot for the wechat request.
     * @param activities List of bot activities.
     * @param openId User's open id from WeChat.
     * @param passiveResponse If using passvice response mode, if set to true, user can only get one reply.
     * @returns Bot response message.
     */
    private async processBotResponse(activities: Activity[], openId: string): Promise<any> {
        let response: any;
        for (const activity of activities) {
            if (activity && activity.type === ActivityTypes.Message) {
                if (activity.channelData) {
                    if (this.passiveResponse) {
                        response = activity.channelData;
                    } else {
                        await this.sendChannelDataToWeChat(activity.channelData);
                    }
                } else {
                    const responseList = (await this.weChatMessageMapper.toWeChatMessage(activity)) as IResponseMessageBase[];
                    if (this.passiveResponse) {
                        response = responseList;
                    } else {
                        await this.sendMessageToWeChat(responseList, openId);
                    }
                }
            }
        }
        return response;
    }

    /**
     * Send raw channel data to WeChat.
     * @param channelData Raw channel data.
     * @returns  Task running result.
     */
    private async sendChannelDataToWeChat(channelData: any) {
        await this.weChatClient.sendMessageToUser(channelData);
    }

    /**
     * Send response based on message type.
     * @param responseList Response message list.
     * @param openId User's open id from WeChat.
     * @returns  Task running result.
     */
    private async sendMessageToWeChat(responseList: IResponseMessageBase[], openId: string) {
        for (const response of responseList) {
            switch (response.MsgType) {
                case ResponseMessageTypes.Text:
                    const textResponse = response as TextResponse;
                    await this.weChatClient.sendTextAsync(openId, textResponse.Content);
                    break;
                case ResponseMessageTypes.Image:
                    const imageResponse = response as ImageResponse;
                    await this.weChatClient.sendImageAsync(
                        openId,
                        imageResponse.image.MediaId
                    );
                    break;
                case ResponseMessageTypes.News:
                    const newsResponse = response as NewsResponse;
                    await this.weChatClient.sendNewsAsync(
                        openId,
                        newsResponse.Articles
                    );
                    break;
                case ResponseMessageTypes.Music:
                    const musicResponse = response as MusicResponse;
                    const music = musicResponse.Music;
                    await this.weChatClient.sendMusicAsync(
                        openId,
                        music.Title,
                        music.Description,
                        music.MusicUrl,
                        music.HQMusicUrl,
                        music.ThumbMediaId
                    );
                    break;
                case ResponseMessageTypes.MPNews:
                    const mpnewsResponse = response as MPNewsResponse;
                    await this.weChatClient.sendMPNewsAsync(
                        openId,
                        mpnewsResponse.MediaId
                    );
                    break;
                case ResponseMessageTypes.Video:
                    const videoRespones = response as VideoResponse;
                    const video = videoRespones.Video;
                    await this.weChatClient.sendVideoAsync(
                        openId,
                        video.MediaId,
                        video.Title,
                        video.Description
                    );
                    break;
                case ResponseMessageTypes.Voice:
                    const voiceResponse = response as VoiceResponse;
                    await this.weChatClient.sendVoiceAsync(
                        openId,
                        voiceResponse.Voice.MediaId
                    );
                    break;
                case ResponseMessageTypes.MessageMenu:
                    const menuResponse = response as MessageMenuResponse;
                    await this.weChatClient.sendMessageMenuAsync(openId, menuResponse.MessageMenu);
                case ResponseMessageTypes.LocationMessage:
                case ResponseMessageTypes.SuccessResponse:
                case ResponseMessageTypes.Unknown:
                case ResponseMessageTypes.NoResponse:
                default:
                    break;
            }
        }
    }
}

/**
 * Parses request message
 * @private
 * @param req The request sent from WeChat.
 * @param secretInfo Secret info for decrypt message.
 */
async function parseRequest(req: WebRequest, secretInfo: SecretInfo): Promise<IRequestMessageBase> {
    const requestRaw = await parseXML(req.body);
    if (!requestRaw.Encrypt) {
        return requestRaw;
    } else {
        const requestMessage = await parseXML(MessageCryptography.decryptMessage(requestRaw, secretInfo));
        return requestMessage;
    }
}

/**
 * Parses xml string
 * @private
 * @param str xml string
 */
function parseXML(str: string): Promise<IRequestMessageBase> {
    const xmlParser = new xml2js.Parser({
        explicitArray: false,
        explicitCharkey: false,
        explicitRoot: false
    });
    return new Promise((resolve, reject) => {
        if (!str) {
            reject(new Error('Document is empty'));
        } else {
            xmlParser.parseString(str, (err?: Error, res?: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(res);
                }
            });
        }
    });
}

/**
 *
 */
function delay(timeout: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, timeout);
    });
}

