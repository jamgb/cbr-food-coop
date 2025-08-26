select 
    SUM(amountpaid) AS hours_volunteered -- legacy program has hours as decimal in amountpaid
from members_history 
WHERE datenew > now() - interval '1 year' and action = 'Volunteered';