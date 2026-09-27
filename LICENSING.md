# 开源许可与商业产品边界 / Licensing and product boundaries

适用日期：2026-09-26。本文解释产品范围，不替代或修改 [LICENSE](LICENSE)，也不增加使用限制或授予插件链接例外。具体产品边界见 [ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)。

## 开源核心

`edgeweir` 控制面与 `edgeweir-node` 节点继续采用 **AGPL-3.0-only**。第三方组件遵循各自的许可证。

- 允许个人和企业在遵守 AGPL 的前提下使用、修改、分发以及提供收费服务；没有“仅限个人”“禁止商用”或必须购买官方授权才能运营的附加条款。
- 组织、成员、邀请、角色权限、组织隔离、站点控制台、平台后台、节点管理和开放 API 属于开源核心。组织可以用于内部团队，也可以被运营者用于管理客户资源；“内部协作”描述产品定位，不限制合法用途。
- 不为节点数、组织数、成员数或站点数增加官方付费许可证门槛；资源保护、权限和运维配额不属于商业功能锁。
- 核心没有官方回连、商业许可证校验或付费功能锁。独立商业产品不改变核心的使用权。
- AGPL 不是禁止收费或禁止竞争的许可证。分发、修改及网络交互涉及的源码义务以 LICENSE 为准，尤其是第 13 条；合规获得的既有版本权利不会因产品规划调整而被收回。

## 独立商业产品

官方计划把**对外客户门户、自助注册购买、套餐与计费、余额与财务、分销与结算**放入独立商业运营产品；官方账户、订阅、许可证和插件分发由独立商业服务承载。这些是产品规划，目前不代表已有可购买的产品或已交付的功能。

这些未来产品中的独立原创代码可以另行采用专有商业许可，并在交付时提供明确条款。把代码放进私有仓库、另一个容器或另一个进程，本身并不会豁免 AGPL：复制核心代码、形成衍生或组合作品、使用第三方依赖时，仍须满足适用许可证。发布闭源插件前需核实集成方式和代码权利；本文没有提供通用插件豁免，也没有给现有核心增加商业双许可。

产品边界约束的是官方开发和交付范围，不禁止社区在 AGPL 允许的范围内自行实现类似功能。付费购买开源插件也不会消除购买者依法获得的开源权利。

## 贡献

向这两个开源仓库提交的贡献按 AGPL-3.0-only 提供，不因存在商业产品而自动授予项目方闭源再许可的权利。未来如需双许可、链接例外或商业代码复用，应先核实版权归属、贡献授权和第三方许可证，并另行明确约定。

## English summary

Both `edgeweir` and `edgeweir-node` remain **AGPL-3.0-only**. Commercial use, modification, redistribution and paid services are permitted subject to that license. There is no personal-use-only restriction or requirement to buy an official license to operate the open-source core.

Organizations, memberships, invitations, access control, organization isolation, the site console, platform administration, node management and public APIs remain in the core. Internal collaboration is a product focus, not a restriction on who may use these features. Core functionality has no official licensing gates based on node, organization, member or site counts, and no vendor phone-home or commercial license checks.

The planned customer commerce portal, self-service purchasing, plans, billing, finance, reselling and settlement belong to a separate commercial operations product. Official accounts, subscriptions, licensing and plugin distribution belong to separate commercial services. These products are not implemented by this policy. Independently authored commercial works may have their own terms; private repositories or process boundaries do not waive AGPL obligations. No plugin linking exception or commercial dual license is granted here.

Community implementations remain permitted under the applicable licenses. Contributions to the core stay AGPL-3.0-only and do not automatically grant proprietary relicensing rights. This document does not amend LICENSE or withdraw rights already granted under it.
