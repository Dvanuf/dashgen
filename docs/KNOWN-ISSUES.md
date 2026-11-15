# Решённые проблемы (грабли) Dashgen на QSEoW

Сервер: dc3-qliks-ap-03.onyx.local (enigma 4747, QRS 4242, сертификаты ~/qlik_build/certs).
Перед правками builder/объектов — сверяйся. Полный аналог из проекта-источника:
`sunlight-qlik-theme/app-template/build/qseow/KNOWN-ISSUES.md`.

## Движок и сборка

| Симптом | Причина | Решение |
|---|---|---|
| doReload мгновенно возвращает false | Стандартный режим движка на этом сервере | Автоматический фолбэк на одноразовую QRS-задачу (src/builder/index.js → reloadApp); скрипт должен быть сохранён (doSave) ДО запуска задачи; после задачи — переоткрыть приложение |
| /qrs/reloadtask/{id}/start → 404 | Особенность сервера | POST /qrs/task/{id}/start (204); успех = статус 7 в /qrs/executionresult/full; задачу удалять (DELETE /qrs/reloadtask/{id}) |
| Пустые листы в клиенте, хотя объекты и verify в порядке | Лист без `cells` + `qChildListDef` | Dashgen всегда кладёт оба; при правках builder не удалять |
| Объект не рендерится, хотя данные в гиперкубе есть (verify проходит) | combochart/piechart из слепков клиента (templates/*.json, createFromTemplate) этим клиентом не рисуются — исследовать служебные поля (аналог стекового бара) | В макетах — гарантированные типы: linechart вместо combo, barchart вместо pie; слепки обновлять только через scripts/extract-templates.js С ЦЕЛЕВОГО сервера |
| gauge 0×0 при создании из слепка | buildHypercube читал только ospec.measures, а KPI/gauge несут одиночное `measure` | buildHypercube нормализует и одиночное measure (objects.js) |
| Каждый patch плодит дубли мастер-элементов | Doc.GetDimensions отсутствует в схеме enigma.js; getObjects({qTypes:['dimension']}) тоже пуст | Перечисление через session-объекты DimensionList/MeasureList (objects.js → listMasterRefs), переиспользование по названию |
| getChildInfos листа возвращает 0 | Dashgen создаёт объекты КОРНЕВЫМИ (не createChild) — клиент рендерит по cells[].name | «Прикреплённые» объекты = имена из cells ВСЕХ листов (reconcileSheets, verify-all); getChildInfos использовать только для filterpane |
| reconcile-сироты уничтожают все объекты | Если считать сиротами всё, что не в getChildInfos — под нож идут рабочие объекты | Сирота = объект, не упомянутый ни в одном cells (builder/index.js → reconcileSheets) |
| Конфликт qId: движок молча переименовывает ребёнка, cells ссылается на старое имя | Одинаковый qId детей на разных листах | qId детей уникальны на приложение; проверка в verify-all |
| Таблица из 2 текстовых измерений может не рендериться (гиперкуб валиден) | Баг клиента | Не использовать для статичного справочника — расширение со статичным HTML (sl-info, путь sl-logo) |
| Призраки детей листа после destroyObject | destroyObject не вычищает ребёнка из child-листа | sheet.destroyChild(qId); целые листы — destroyObject безопасен |
| Сортировка таблицы «Недопустимый порядок» | Размерность таблицы не сортируется выражением; чужие qColumnOrder/qInterColumnSortOrder | qSortByLoadOrder + qExpression {}; порядки колонок — по фактическому числу колонок |

## QRS-лимиты сервера

| Задача | Статус | Рабочий путь |
|---|---|---|
| reload | /qrs/reloadtask/{id}/start 404 | /qrs/task/{id}/start |
| экспорт .qvf | /qrs/app/{id}/export 404 | QMC → Apps → Export (вручную) |
| импорт темы | /qrs/theme/* 404 | расширение sl-theme-light (CSS-инжект) или QMC |
| расширения | /qrs/extension/upload работает | multipart qextFile + zip (HTTP 201), см. qrs.uploadExtension |
| scriptlog | /qrs/executionresult/{id}/scriptlog 404 | детали — messages из executionresult |

## Проверка

- После любых правок: `node cli.js build <spec> --verify-all` (полный цикл: листы/cells/гиперкубы/сироты/фильтры/условия приёмки/макет) — код 0 = чисто.
- Пустые листы/графики проверяются ТОЛЬКО визуально в клиенте — verify не видит, что график реально нарисован (комбо/pie с данными в гиперкубе не рисовались и verify их пропускал).
- Повторная create-сборка удаляет приложение по имени — правки существующего дашборда только через `patch --app` / UI «Подключиться к существующему».
