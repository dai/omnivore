import Parser from 'rss-parser'
import { Brackets } from 'typeorm'
import { Subscription } from '../../entity/subscription'
import { env } from '../../env'
import {
  MutationSubscribeArgs,
  MutationUnsubscribeArgs,
  MutationUpdateSubscriptionArgs,
  QuerySubscriptionsArgs,
  SortBy,
  SortOrder,
  SubscribeError,
  SubscribeErrorCode,
  SubscribeSuccess,
  SubscriptionsError,
  SubscriptionsErrorCode,
  SubscriptionsSuccess,
  SubscriptionStatus,
  SubscriptionType,
  UnsubscribeError,
  UnsubscribeErrorCode,
  UnsubscribeSuccess,
  UpdateSubscriptionError,
  UpdateSubscriptionErrorCode,
  UpdateSubscriptionSuccess,
} from '../../generated/graphql'
import { getRepository } from '../../repository'
import { unsubscribe } from '../../services/subscriptions'
import { Merge } from '../../util'
import { analytics } from '../../utils/analytics'
import { enqueueRssFeedFetch } from '../../utils/createTask'
import { authorized } from '../../utils/helpers'

type PartialSubscription = Omit<Subscription, 'newsletterEmail'>

const parser = new Parser({
  timeout: 30000, // 30 seconds
  maxRedirects: 5,
  headers: {
    // some rss feeds require user agent
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    Accept:
      'application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4',
  },
})

export type SubscriptionsSuccessPartial = Merge<
  SubscriptionsSuccess,
  { subscriptions: PartialSubscription[] }
>
export const subscriptionsResolver = authorized<
  SubscriptionsSuccessPartial,
  SubscriptionsError,
  QuerySubscriptionsArgs
>(async (_obj, { sort, type }, { uid, log }) => {
  try {
    const sortBy =
      sort?.by === SortBy.UpdatedTime ? 'lastFetchedAt' : 'createdAt'
    const sortOrder = sort?.order === SortOrder.Ascending ? 'ASC' : 'DESC'

    const queryBuilder = getRepository(Subscription)
      .createQueryBuilder('subscription')
      .leftJoinAndSelect('subscription.newsletterEmail', 'newsletterEmail')
      .where({
        user: { id: uid },
      })

    if (type && type == SubscriptionType.Newsletter) {
      queryBuilder.andWhere({
        type,
        status: SubscriptionStatus.Active,
      })
    } else if (type && type == SubscriptionType.Rss) {
      queryBuilder.andWhere({
        type,
      })
    } else {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where({
            type: SubscriptionType.Newsletter,
            status: SubscriptionStatus.Active,
          }).orWhere({
            type: SubscriptionType.Rss,
          })
        })
      )
    }

    const subscriptions = await queryBuilder
      .orderBy(`subscription.${sortBy}`, sortOrder, 'NULLS LAST')
      .getMany()

    return {
      subscriptions,
    }
  } catch (error) {
    log.error(error)
    return {
      errorCodes: [SubscriptionsErrorCode.BadRequest],
    }
  }
})

export type UnsubscribeSuccessPartial = Merge<
  UnsubscribeSuccess,
  { subscription: PartialSubscription }
>
export const unsubscribeResolver = authorized<
  UnsubscribeSuccessPartial,
  UnsubscribeError,
  MutationUnsubscribeArgs
>(async (_, { name, subscriptionId }, { uid, log }) => {
  log.info('unsubscribeResolver')

  try {
    const queryBuilder = getRepository(Subscription)
      .createQueryBuilder('subscription')
      .leftJoinAndSelect('subscription.newsletterEmail', 'newsletterEmail')
      .where({ user: { id: uid } })

    if (subscriptionId) {
      // if subscriptionId is provided, ignore name
      queryBuilder.andWhere({ id: subscriptionId })
    } else {
      // if subscriptionId is not provided, use name for old clients
      queryBuilder.andWhere({ name })
    }

    const subscription = await queryBuilder.getOne()

    if (!subscription) {
      return {
        errorCodes: [UnsubscribeErrorCode.NotFound],
      }
    }

    if (
      subscription.type === SubscriptionType.Newsletter &&
      !subscription.unsubscribeMailTo &&
      !subscription.unsubscribeHttpUrl
    ) {
      log.info('No unsubscribe method found for newsletter subscription')
    }

    await unsubscribe(subscription)

    analytics.track({
      userId: uid,
      event: 'unsubscribed',
      properties: {
        name,
        env: env.server.apiEnv,
      },
    })

    return {
      subscription,
    }
  } catch (error) {
    log.error('failed to unsubscribe', error)
    return {
      errorCodes: [UnsubscribeErrorCode.BadRequest],
    }
  }
})

export type SubscribeSuccessPartial = Merge<
  SubscribeSuccess,
  { subscriptions: PartialSubscription[] }
>
export const subscribeResolver = authorized<
  SubscribeSuccessPartial,
  SubscribeError,
  MutationSubscribeArgs
>(async (_, { input }, { authTrx, uid, log }) => {
  log.info('subscribeResolver')

  try {
    // find existing subscription
    const subscription = await authTrx((t) =>
      t.getRepository(Subscription).findOneBy({
        url: input.url || undefined,
        name: input.name || undefined,
        user: { id: uid },
        status: SubscriptionStatus.Active,
        type: input.subscriptionType || SubscriptionType.Rss, // default to rss
      })
    )
    if (subscription) {
      return {
        errorCodes: [SubscribeErrorCode.AlreadySubscribed],
      }
    }

    analytics.track({
      userId: uid,
      event: 'subscribed',
      properties: {
        ...input,
        env: env.server.apiEnv,
      },
    })

    // create new rss subscription
    if (input.url) {
      const MAX_RSS_SUBSCRIPTIONS = 150
      // validate rss feed
      const feed = await parser.parseURL(input.url)

      // limit number of rss subscriptions to 50
      const newSubscriptions = (await authTrx((t) =>
        t.query(
          `insert into omnivore.subscriptions (name, url, description, type, user_id, icon) 
        select $1, $2, $3, $4, $5, $6 from omnivore.subscriptions 
        where user_id = $5 and type = 'RSS' and status = 'ACTIVE' 
        having count(*) < $7 
        returning *;`,
          [
            feed.title,
            input.url,
            feed.description || null,
            SubscriptionType.Rss,
            uid,
            feed.image?.url || null,
            MAX_RSS_SUBSCRIPTIONS,
          ]
        )
      )) as Subscription[]

      if (newSubscriptions.length === 0) {
        return {
          errorCodes: [SubscribeErrorCode.ExceededMaxSubscriptions],
        }
      }

      // create a cloud task to fetch rss feed item for the new subscription
      await enqueueRssFeedFetch(uid, newSubscriptions[0])

      return {
        subscriptions: newSubscriptions,
      }
    }

    log.info('missing url or name')
    return {
      errorCodes: [SubscribeErrorCode.BadRequest],
    }
  } catch (error) {
    log.error('failed to subscribe', error)
    if (error instanceof Error && error.message === 'Status code 404') {
      return {
        errorCodes: [SubscribeErrorCode.NotFound],
      }
    }
    return {
      errorCodes: [SubscribeErrorCode.BadRequest],
    }
  }
})

export type UpdateSubscriptionSuccessPartial = Merge<
  UpdateSubscriptionSuccess,
  { subscription: PartialSubscription }
>
export const updateSubscriptionResolver = authorized<
  UpdateSubscriptionSuccessPartial,
  UpdateSubscriptionError,
  MutationUpdateSubscriptionArgs
>(async (_, { input }, { authTrx, uid, log }) => {
  try {
    analytics.track({
      userId: uid,
      event: 'update_subscription',
      properties: {
        ...input,
        env: env.server.apiEnv,
      },
    })

    const updatedSubscription = await authTrx(async (t) => {
      const repo = t.getRepository(Subscription)

      // update subscription
      await t.getRepository(Subscription).save({
        id: input.id,
        name: input.name || undefined,
        description: input.description || undefined,
        lastFetchedAt: input.lastFetchedAt
          ? new Date(input.lastFetchedAt)
          : undefined,
        status: input.status || undefined,
      })

      return repo.findOneByOrFail({
        id: input.id,
        user: { id: uid },
      })
    })

    return {
      subscription: updatedSubscription,
    }
  } catch (error) {
    log.error('failed to update subscription', error)
    return {
      errorCodes: [UpdateSubscriptionErrorCode.BadRequest],
    }
  }
})
